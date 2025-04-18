const Booking = require('../models/booking');
const Listing = require('../models/listing');
const User = require('../models/user');
const nodemailer = require('nodemailer');
const htmlPdf = require('html-pdf');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

// Email transporter setup
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Generate PDF receipt
const generateReceipt = async (booking) => {
    try {
        // Generate QR code
        const qrCodeData = `Booking ID: ${booking._id}\nProperty: ${booking.listing.title}\nCheck-in: ${booking.checkIn}\nCheck-out: ${booking.checkOut}`;
        const qrCodePath = path.join(__dirname, '../public/qrcodes', `${booking._id}.png`);
        await QRCode.toFile(qrCodePath, qrCodeData);

        // Read the template
        const templatePath = path.join(__dirname, '../views/receipts/booking-receipt.ejs');
        const template = fs.readFileSync(templatePath, 'utf8');

        // Render the template with booking data
        const html = ejs.render(template, {
            booking,
            qrCodePath: `/qrcodes/${booking._id}.png`
        });

        // Generate PDF
        const pdfPath = path.join(__dirname, '../public/receipts', `${booking._id}.pdf`);
        await new Promise((resolve, reject) => {
            htmlPdf.create(html).toFile(pdfPath, (err, res) => {
                if (err) reject(err);
                else resolve(res);
            });
        });

        return pdfPath;
    } catch (error) {
        console.error('Error generating receipt:', error);
        throw error;
    }
};

// Send confirmation emails
const sendConfirmationEmails = async (booking) => {
    try {
        // Get user and host details
        const user = await User.findById(booking.author);
        const host = await User.findById(booking.listing.author);
        const listing = await Listing.findById(booking.listing);

        // Generate PDF receipt
        const receiptPath = await generateReceipt(booking);

        // Send email to guest
        const guestEmailContext = {
            guestName: user.username,
            hostName: host.username,
            listingTitle: listing.title,
            checkInDate: booking.checkIn,
            checkOutDate: booking.checkOut,
            totalPrice: (booking.amount.total / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' }),
            bookingId: booking._id
        };

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: user.email,
            subject: 'Booking Confirmation',
            html: ejs.render(fs.readFileSync(path.join(__dirname, '../views/emails/booking-confirmation.ejs'), 'utf8'), guestEmailContext),
            attachments: [{
                filename: 'booking-receipt.pdf',
                path: receiptPath
            }]
        });

        // Send email to host
        const hostEmailContext = {
            hostName: host.username,
            guestName: user.username,
            guestEmail: user.email,
            guestPhone: user.phone,
            listingTitle: listing.title,
            checkInDate: booking.checkIn,
            checkOutDate: booking.checkOut,
            totalPrice: (booking.amount.total / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' }),
            bookingId: booking._id,
            numGuests: booking.guests
        };

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: host.email,
            subject: 'New Booking Notification',
            html: ejs.render(fs.readFileSync(path.join(__dirname, '../views/emails/host-notification.ejs'), 'utf8'), hostEmailContext)
        });

        // Clean up temporary files
        fs.unlinkSync(receiptPath);
        fs.unlinkSync(path.join(__dirname, '../public/qrcodes', `${booking._id}.png`));
    } catch (error) {
        console.error('Error sending confirmation emails:', error);
        throw error;
    }
};

// Create booking
module.exports.createBooking = async (req, res) => {
    try {
        const { listingId, checkIn, checkOut, guests, paymentMode, paymentId } = req.body;
        
        // Get listing details
        const listing = await Listing.findById(listingId);
        if (!listing) {
            req.flash('error', 'Listing not found');
            return res.redirect('back');
        }

        // Check guest limit
        if (guests > listing.maxGuests) {
            req.flash('error', `Maximum ${listing.maxGuests} guests allowed`);
            return res.redirect('back');
        }

        // Calculate amount
        const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24));
        const basePrice = listing.price * nights;
        const taxes = basePrice * 0.18; // 18% GST
        const total = basePrice + taxes;

        // Create booking
        const booking = new Booking({
            listing: listingId,
            author: req.user._id,
            checkIn,
            checkOut,
            guests,
            paymentMode,
            paymentId,
            amount: {
                basePrice,
                taxes,
                total
            }
        });

        await booking.save();

        // Send notifications
        const host = await User.findById(listing.author);
        const guest = await User.findById(req.user._id);

        // Send email to host
        const hostEmail = {
            to: host.email,
            subject: 'New Booking Received',
            text: `You have received a new booking from ${guest.username} for ${listing.title}. 
                   Booking ID: ${booking.bookingId}
                   Check-in: ${checkIn}
                   Check-out: ${checkOut}
                   Guests: ${guests}
                   Total Amount: ₹${total}`
        };

        // Send email to guest
        const guestEmail = {
            to: guest.email,
            subject: 'Booking Confirmed',
            text: `Your booking for ${listing.title} has been confirmed.
                   Booking ID: ${booking.bookingId}
                   Check-in: ${checkIn}
                   Check-out: ${checkOut}
                   Guests: ${guests}
                   Total Amount: ₹${total}
                   Payment Mode: ${paymentMode}`
        };

        // TODO: Implement email sending logic

        req.flash('success', 'Booking confirmed successfully!');
        res.redirect(`/bookings/${booking._id}`);
    } catch (err) {
        console.error(err);
        req.flash('error', 'Something went wrong');
        res.redirect('back');
    }
};

// Cancel booking
module.exports.cancelBooking = async (req, res) => {
    try {
        const { bookingId, reason } = req.body;
        
        const booking = await Booking.findById(bookingId);
        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('back');
        }

        // Update booking status
        booking.status = 'cancelled';
        booking.cancellationReason = reason;
        await booking.save();

        // Send notifications
        const listing = await Listing.findById(booking.listing);
        const host = await User.findById(listing.author);
        const guest = await User.findById(booking.author);

        // Send email to host
        const hostEmail = {
            to: host.email,
            subject: 'Booking Cancelled',
            text: `Booking ${booking.bookingId} has been cancelled by ${guest.username}.
                   Reason: ${reason}`
        };

        // Send email to guest
        const guestEmail = {
            to: guest.email,
            subject: 'Booking Cancelled',
            text: `Your booking ${booking.bookingId} for ${listing.title} has been cancelled.
                   Reason: ${reason}`
        };

        // TODO: Implement email sending logic

        req.flash('success', 'Booking cancelled successfully');
        res.redirect('back');
    } catch (err) {
        console.error(err);
        req.flash('error', 'Something went wrong');
        res.redirect('back');
    }
}; 