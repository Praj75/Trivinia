const path = require('path');
const fs = require('fs').promises;

const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const ejs = require('ejs');
const puppeteer = require('puppeteer');
const { check, validationResult } = require('express-validator');
const Listing = require('../models/listing');
const Booking = require('../models/booking');
const { ExpressError } = require('../utils/ExpressError');
const wrapAsync = require('../utils/wrapAsync');
const { sendEmail, transporter } = require('../utils/email');
const User = require('../models/users');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Verify email configuration
transporter.verify(function (error, success) {
    if (error) {
        console.error('❌ Email configuration error:', error);
    } else {
        console.log('✅ Email server is ready to send messages');
    }
});

// 🔑 Get Razorpay Key
router.get("/getRazorPayKey", (req, res) => {
    res.json({ key: process.env.RAZORPAY_KEY_ID });
});

// 🧾 Create Razorpay Order
router.post("/create_order", [
    check('listingId').isMongoId().withMessage('Invalid listing ID'),
    check('checkIn').isISO8601().withMessage('Invalid check-in date'),
    check('checkOut').isISO8601().withMessage('Invalid check-out date'),
    check('guests').isInt({ min: 1 }).withMessage('Number of guests must be at least 1'),
    check('totalPrice').isNumeric().withMessage('Invalid total price')
], wrapAsync(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    try {
        const { 
            listingId, 
            checkIn, 
            checkOut, 
            guests, 
            totalPrice 
        } = req.body;

        // Validate dates
        const start = new Date(checkIn);
        const end = new Date(checkOut);
        if (start >= end) {
            return res.status(400).json({ error: 'Check-out date must be after check-in date' });
        }

        // Check listing availability
        const listing = await Listing.findById(listingId);
        if (!listing) {
            return res.status(404).json({ error: 'Listing not found' });
        }

        // Check for existing bookings
        const existingBookings = await Booking.find({
            listing: listingId,
            status: { $in: ['confirmed', 'pending'] },
            $or: [
                { checkIn: { $lt: end, $gte: start } },
                { checkOut: { $gt: start, $lte: end } }
            ]
        });

        if (existingBookings.length > 0) {
            return res.status(400).json({ error: 'Selected dates are not available' });
        }

        // Convert totalPrice to paise (multiply by 100)
        const amountInPaise = Math.round(totalPrice * 100);

        // Generate a unique receipt ID
        const receiptId = `receipt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create order
        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: 'INR',
            receipt: receiptId,
            notes: {
                listingId,
                checkIn,
                checkOut,
                guests,
                totalPrice
            }
        });

        // Store order details in session
        req.session.orderDetails = {
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            status: order.status,
            listingId,
            checkIn,
            checkOut,
            guests,
            totalPrice
        };

        // Save session
        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        res.json({
            id: order.id,
            amount: order.amount,
            currency: order.currency,
            status: order.status
        });
    } catch (error) {
        console.error("Error creating order:", error);
        res.status(500).json({ error: "Failed to create order", details: error.message });
    }
}));

// 💾 Store payment + booking in session
router.post("/store-payment-details", async (req, res) => {
    try {
        const { paymentDetails, bookingDetails, email, receiptFileName } = req.body;

        if (!paymentDetails || !bookingDetails) {
            return res.status(400).json({ error: 'Missing payment or booking details' });
        }

        // Merge new data with existing session data
            req.session.paymentDetails = {
                ...req.session.paymentDetails,
                ...paymentDetails
            };
            req.session.bookingDetails = {
                ...req.session.bookingDetails,
                ...bookingDetails
            };
        if (email) req.session.email = email;
        if (receiptFileName) req.session.receiptFileName = receiptFileName;

        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Error storing session data:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 🧾 Generate PDF Receipt
async function generateReceipt(paymentDetails, bookingDetails, receiptFileName) {
    try {
        const templatePath = path.join(__dirname, '..', 'views', 'receipt.ejs');
        const template = await fs.readFile(templatePath, 'utf-8');
        const html = ejs.render(template, { 
            paymentDetails, 
            bookingDetails,
            formatDate: (date) => new Date(date).toLocaleDateString(),
            formatCurrency: (amount) => `₹${(amount/100).toLocaleString('en-IN')}`
        });

        const browser = await puppeteer.launch({ 
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(html);

        const receiptDir = path.join(__dirname, '..', 'temp', 'receipts');
        await fs.mkdir(receiptDir, { recursive: true });

        const receiptPath = path.join(receiptDir, receiptFileName);
        await page.pdf({ 
            path: receiptPath, 
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }
        });

        await browser.close();
        return receiptPath;
    } catch (error) {
        console.error("Error generating receipt:", error);
        throw error;
    }
}

// 📧 Send Booking Confirmation Email
async function sendBookingConfirmation(email, emailData, paymentDetails, receiptPath) {
    try {
        // Read and compile email template
        const templatePath = path.join(__dirname, '..', 'views', 'emails', 'bookingConfirmation.ejs');
        const emailTemplate = await fs.readFile(templatePath, 'utf-8');
        const html = ejs.render(emailTemplate, emailData);

        const mailOptions = {
            from: `"DART Bookings" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: "Your Booking is Confirmed! - DART",
            html: html,
            attachments: receiptPath ? [
                {
                    filename: 'booking-receipt.pdf',
                    path: receiptPath
                }
            ] : []
        };

        const info = await transporter.sendMail(mailOptions);
        console.log("✅ Booking confirmation email sent:", info.messageId);
        
        // Clean up receipt file after sending
        if (receiptPath) {
            await fs.unlink(receiptPath).catch(err => 
                console.error("Warning: Could not delete receipt file:", err)
            );
        }
    } catch (error) {
        console.error("❌ Error sending booking confirmation:", error);
        throw error;
    }
}

// 📧 Send Host Notification
async function sendHostNotification(hostEmail, emailData, paymentDetails) {
    try {
        // Read and compile email template
        const templatePath = path.join(__dirname, '..', 'views', 'emails', 'hostNotification.ejs');
        const emailTemplate = await fs.readFile(templatePath, 'utf-8');
        const html = ejs.render(emailTemplate, emailData);

        const mailOptions = {
            from: `"DART Bookings" <${process.env.EMAIL_USER}>`,
            to: hostEmail,
            subject: "New Booking Received! - DART",
            html: html
        };

        const info = await transporter.sendMail(mailOptions);
        console.log("✅ Host notification sent:", info.messageId);
    } catch (error) {
        console.error("❌ Error sending host notification:", error);
        throw error;
    }
}

// 📧 Send Booking Confirmation Emails
async function sendBookingConfirmationEmails(booking, listing, user, host) {
    try {
        // Prepare email data
        const emailData = {
            guestName: user.username,
            listingTitle: listing.title,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            totalPrice: booking.amount.total,
            bookingId: booking.bookingId
        };

        // Send confirmation email to guest
        await sendBookingConfirmation(user.email, emailData, booking);

        // Send notification to host
        await sendHostNotification(host.email, {
            hostName: host.username,
            guestName: user.username,
            title: listing.title,
            checkIn: new Date(booking.checkIn).toLocaleDateString('en-US', { 
                weekday: 'short', 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            }),
            checkOut: new Date(booking.checkOut).toLocaleDateString('en-US', { 
                weekday: 'short', 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric' 
            }),
            amount: booking.amount.total,
            bookingId: booking._id
        });

        console.log('✅ Booking confirmation emails sent successfully');
    } catch (error) {
        console.error('❌ Error sending booking confirmation emails:', error);
        throw error;
    }
}

// ✅ Payment Success Flow
router.get('/paymentSuccess', async (req, res) => {
    try {
        // Get parameters from the request
        const { 
            listingId,
            checkIn,
            checkOut,
            guests,
            paymentId,
            orderId,
            signature,
            paymentMode,
            author,
            bookingId,
            email,
            name,
            status,
            amount
        } = req.query;

        // Log received parameters for debugging
        console.log('Received payment success parameters:', {
            listingId,
            checkIn,
            checkOut,
            guests,
            paymentId,
            orderId,
            signature,
            paymentMode,
            author,
            bookingId,
            email,
            name,
            status,
            amount
        });

        // Validate required parameters
        const requiredParams = {
            listingId,
            checkIn,
            checkOut,
            guests,
            paymentId,
            orderId,
            signature,
            paymentMode,
            author,
            bookingId,
            email,
            name,
            status,
            amount
        };

        const missingParams = Object.entries(requiredParams)
            .filter(([key, value]) => !value)
            .map(([key]) => key);

        if (missingParams.length > 0) {
            console.error('Missing required parameters:', missingParams);
            return res.redirect('/bookings?error=' + encodeURIComponent('Missing required parameters'));
        }

        // Verify payment signature
        const body = orderId + "|" + paymentId;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (expectedSignature !== signature) {
            console.error('Invalid payment signature:', {
                expected: expectedSignature,
                received: signature
            });
            return res.redirect('/bookings?error=' + encodeURIComponent('Invalid payment signature'));
        }

        // Check if booking with this orderId already exists
        const existingBooking = await Booking.findOne({ orderId });
        if (existingBooking) {
            console.log('Booking already exists, redirecting to existing booking:', existingBooking._id);
            return res.redirect(`/bookings/${existingBooking._id}`);
        }

        // Get listing and user details
        const listing = await Listing.findById(listingId);
        const user = await User.findById(author);

        if (!listing || !user) {
            console.error('Listing or user not found:', {
                listingId,
                author,
                listingFound: !!listing,
                userFound: !!user
            });
            return res.redirect('/bookings?error=' + encodeURIComponent('Listing or user not found'));
        }

        // Calculate base price and taxes
        const basePrice = Math.round(parseInt(amount) * 0.9); // 90% of total
        const taxes = Math.round(parseInt(amount) * 0.1); // 10% of total

        // Create the booking
        const booking = await Booking.create({
            bookingId: bookingId,
            listing: listingId,
            author: author,
            checkIn: new Date(checkIn),
            checkOut: new Date(checkOut),
            guests: parseInt(guests),
            amount: {
                basePrice: basePrice,
                taxes: taxes,
                total: parseInt(amount)
            },
            paymentMode: paymentMode,
            status: status,
            paymentId: paymentId,
            orderId: orderId,
            contact: {
                email: email,
                name: name
            }
        });

        // Add booking dates to listing
        await listing.addBookedDates(checkIn, checkOut, booking._id);

        // Send confirmation emails
        try {
            await sendBookingConfirmationEmails(booking, listing, user, listing.owner);
        } catch (emailError) {
            console.error('Error sending confirmation emails:', emailError);
            // Continue with redirect even if email fails
        }

        // Redirect to the booking details page
        res.redirect(`/bookings/${booking._id}`);

    } catch (error) {
        console.error('Payment success error:', error);
        res.redirect('/bookings?error=' + encodeURIComponent(error.message));
    }
});

// Handle booking cancellation and refund
router.post('/cancel-booking', async (req, res) => {
    try {
        const { bookingId } = req.body;
        if (!bookingId) {
            return res.status(400).json({ error: 'Booking ID is required' });
        }

        const booking = await Booking.findById(bookingId)
            .populate('user')
            .populate({
                path: 'listing',
                populate: {
                    path: 'owner'
                }
            });
        
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        if (booking.status === 'cancelled') {
            return res.status(400).json({ error: 'Booking is already cancelled' });
        }

        // Calculate refund amount
        const refundAmount = booking.calculateRefund();
        
        if (refundAmount <= 0) {
            // If no refund is due, just update the booking status
            booking.status = 'cancelled';
            booking.paymentStatus = 'paid'; // No refund needed
            booking.refundAmount = 0;
            await booking.save();
            
            return res.json({
                success: true,
                message: 'Booking cancelled successfully (no refund due)',
                refundAmount: 0
            });
        }

        // Process refund through Razorpay
        const refund = await razorpay.payments.refund(booking.paymentId, {
            amount: refundAmount * 100, // Convert to paise
            speed: "normal",
            notes: {
                reason: "Booking cancellation",
                bookingId: booking._id.toString()
            }
        });

        // Update booking status
        booking.status = 'cancelled';
        booking.paymentStatus = refundAmount === booking.totalAmount ? 'refunded' : 'partially_refunded';
        booking.refundAmount = refundAmount;
        await booking.save();

        // Send cancellation emails
        const emailData = {
            user: booking.user,
            booking: {
                ...booking.toObject(),
                propertyName: booking.listing.title,
                checkInDate: booking.checkIn,
                checkOutDate: booking.checkOut,
                totalPrice: booking.totalAmount,
                refundAmount: refundAmount,
                paymentStatus: refundAmount === booking.totalAmount ? 'refunded' : 'partially_refunded'
            }
        };

        // Send email to user
        const userEmailHtml = await ejs.renderFile(
            path.join(__dirname, '../views/emails/bookingCancellation.ejs'),
            emailData
        );

        // Send email to host
        const hostEmailHtml = await ejs.renderFile(
            path.join(__dirname, '../views/emails/hostNotification.ejs'),
            {
                hostName: booking.listing.owner.username,
                guestName: booking.user.username,
                title: booking.listing.title,
                checkIn: new Date(booking.checkIn).toLocaleDateString('en-US', { 
                    weekday: 'short', 
                    year: 'numeric', 
                    month: 'short', 
                    day: 'numeric' 
                }),
                checkOut: new Date(booking.checkOut).toLocaleDateString('en-US', { 
                    weekday: 'short', 
                    year: 'numeric', 
                    month: 'short', 
                    day: 'numeric' 
                }),
                amount: booking.totalAmount,
                bookingId: booking._id,
                refundAmount: refundAmount
            }
        );

        // Send both emails
        await Promise.all([
            transporter.sendMail({
                from: `"DART Bookings" <${process.env.EMAIL_USER}>`,
                to: booking.user.email,
                subject: 'Booking Cancellation Confirmation',
                html: userEmailHtml
            }),
            transporter.sendMail({
                from: `"DART Bookings" <${process.env.EMAIL_USER}>`,
                to: booking.listing.owner.email,
                subject: 'Booking Cancellation Notification',
                html: hostEmailHtml
            })
        ]);

        res.json({
            success: true,
            message: 'Booking cancelled successfully',
            refundAmount,
            refundId: refund.id
        });
    } catch (error) {
        console.error('Error cancelling booking:', error);
        res.status(500).json({ 
            error: 'Failed to cancel booking',
            details: error.message 
        });
    }
});

module.exports = router;
