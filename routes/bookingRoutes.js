const express = require('express');
const router = express.Router();
const Booking = require('../models/booking');
const Listing = require('../models/listing');
const User = require('../models/users');
const { isLoggedIn } = require('../middleware');
const wrapAsync = require('../utils/wrapAsync');
const mongoose = require('mongoose');
const { sendEmail, transporter } = require('../utils/email');

// Email sending function
async function sendBookingEmail(to, subject, html) {
    try {
        await sendEmail({
            to,
            subject,
            template: 'booking-confirmation',
            context: { html }
        });
        console.log('Email sent successfully');
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

// Function to send booking confirmation emails
async function sendBookingConfirmationEmails(booking, listing, user, host) {
    // Email to guest
    const guestEmailHtml = `
        <h1>Booking Confirmation</h1>
        <p>Dear ${user.username},</p>
        <p>Your booking for ${listing.title} has been confirmed!</p>
        <h2>Booking Details:</h2>
        <ul>
            <li>Check-in: ${booking.checkIn.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Check-out: ${booking.checkOut.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Number of guests: ${booking.guests}</li>
            <li>Total amount: ₹${(booking.totalPrice/100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</li>
        </ul>
        <p>Property Address: ${listing.location}</p>
        <p>Host Contact: ${host.email}</p>
        <p>Thank you for choosing our service!</p>
    `;

    // Email to host
    const hostEmailHtml = `
        <h1>New Booking Received</h1>
        <p>Dear ${host.username},</p>
        <p>You have received a new booking for ${listing.title}!</p>
        <h2>Booking Details:</h2>
        <ul>
            <li>Guest Name: ${user.username}</li>
            <li>Check-in: ${booking.checkIn.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Check-out: ${booking.checkOut.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Number of guests: ${booking.guests}</li>
            <li>Total amount: ₹${(booking.totalPrice/100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</li>
        </ul>
        <p>Guest Contact: ${user.email}</p>
    `;

    await Promise.all([
        sendBookingEmail(user.email, 'Booking Confirmation - Your Stay is Confirmed!', guestEmailHtml),
        sendBookingEmail(host.email, 'New Booking Received - Action Required', hostEmailHtml)
    ]);
}

// Function to send booking cancellation emails
async function sendBookingCancellationEmails(booking, listing, user, host) {
    // Email to guest
    const guestEmailHtml = `
        <h1>Booking Cancellation Confirmation</h1>
        <p>Dear ${user.username},</p>
        <p>Your booking for ${listing.title} has been cancelled as requested.</p>
        <h2>Cancelled Booking Details:</h2>
        <ul>
            <li>Check-in: ${booking.checkIn.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Check-out: ${booking.checkOut.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Number of guests: ${booking.guests}</li>
            <li>Total amount: ₹${(booking.totalPrice/100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</li>
        </ul>
        <p>If you didn't request this cancellation, please contact us immediately.</p>
    `;

    // Email to host
    const hostEmailHtml = `
        <h1>Booking Cancellation Notice</h1>
        <p>Dear ${host.username},</p>
        <p>A booking for ${listing.title} has been cancelled.</p>
        <h2>Cancelled Booking Details:</h2>
        <ul>
            <li>Guest Name: ${user.username}</li>
            <li>Check-in: ${booking.checkIn.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Check-out: ${booking.checkOut.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</li>
            <li>Number of guests: ${booking.guests}</li>
            <li>Total amount: ₹${(booking.totalPrice/100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</li>
        </ul>
        <p>Your property is now available for these dates.</p>
    `;

    await Promise.all([
        sendBookingEmail(user.email, 'Booking Cancellation Confirmation', guestEmailHtml),
        sendBookingEmail(host.email, 'Booking Cancellation Notice', hostEmailHtml)
    ]);
}

// Get all bookings for the current user
router.get('/', isLoggedIn, async (req, res) => {
    try {
        // Get user's bookings with proper population
        const bookings = await Booking.find({ author: req.user._id })
            .populate({
                path: 'listing',
                select: 'title images price location'
            })
            .sort({ createdAt: -1 });

        // Get user's listings
        const listings = await Listing.find({ owner: req.user._id })
            .select('title images price location')
            .sort({ createdAt: -1 });

        // Get error message from query parameter if it exists
        const error = req.query.error ? decodeURIComponent(req.query.error) : null;

        res.render('bookings/index', { 
            bookings,
            listings,
            error,
            currentUser: req.user,
            title: 'My Bookings'
        });
    } catch (error) {
        console.error('Error fetching bookings:', error);
        req.flash('error', 'Failed to load bookings');
        res.redirect('/');
    }
});

// Create a new booking
router.post('/', isLoggedIn, wrapAsync(async (req, res) => {
    try {
        const { listingId, checkIn, checkOut, totalAmount, orderId, paymentId } = req.body;
        
        // Get listing
        const listing = await Listing.findById(listingId);
        if (!listing) {
            req.flash('error', 'Listing not found');
            return res.redirect('/listings');
        }

        // Create new booking - ensure totalAmount is stored in paise
        const booking = new Booking({
            listing: listingId,
            user: req.user._id,
            checkIn: new Date(checkIn),
            checkOut: new Date(checkOut),
            totalPrice: Math.round(parseFloat(totalAmount) * 100), // Convert to paise and ensure it's an integer
            orderId: orderId,
            paymentId: paymentId,
            status: 'confirmed'
        });
        
        await booking.save();

        // Add booking dates to listing using the model method
        await listing.addBookedDates(checkIn, checkOut, booking._id);
        
        // Get host information
        const host = await User.findById(listing.owner);

        // Send booking confirmation emails
        await sendBookingConfirmationEmails(booking, listing, req.user, host);

        req.flash('success', 'Booking confirmed successfully!');
        res.redirect(`/bookings/${booking._id}`);
    } catch (error) {
        console.error('Error creating booking:', error);
        req.flash('error', 'Failed to create booking');
        res.redirect('/listings');
    }
}));

// Get a specific booking
router.get('/:id', isLoggedIn, wrapAsync(async (req, res) => {
    try {
        // Validate booking ID
        if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
            req.flash('error', 'Invalid booking ID');
            return res.redirect('/bookings');
        }

        const booking = await Booking.findById(req.params.id)
            .populate({
                path: 'listing',
                select: 'title description price image images location owner'
            })
            .populate({
                path: 'user',
                select: 'username email'
            });

        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('/bookings');
        }

        // Check if the booking belongs to the current user
        if (booking.user._id.toString() !== req.user._id.toString()) {
            req.flash('error', 'You do not have permission to view this booking');
            return res.redirect('/bookings');
        }

        // Ensure listing has at least one image
        if (!booking.listing.images || booking.listing.images.length === 0) {
            booking.listing.images = [{ url: '/images/default-listing.jpg' }];
        }

        res.render('bookings/show', { booking });
    } catch (error) {
        console.error('Error fetching booking:', error);
        req.flash('error', 'Failed to fetch booking details');
        res.redirect('/bookings');
    }
}));

// Update booking
router.put('/:id', isLoggedIn, wrapAsync(async (req, res) => {
    try {
        const { checkIn, checkOut } = req.body;
    
        const booking = await Booking.findById(req.params.id);
        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('/bookings');
        }
        
        // Check if the booking belongs to the current user
        if (booking.user.toString() !== req.user._id.toString()) {
            req.flash('error', 'You do not have permission to modify this booking');
            return res.redirect('/bookings');
        }
        
        // Update booking
        booking.checkIn = new Date(checkIn);
        booking.checkOut = new Date(checkOut);
        
        await booking.save();
        req.flash('success', 'Booking updated successfully!');
        res.redirect(`/bookings/${booking._id}`);
    } catch (error) {
        console.error('Error updating booking:', error);
        req.flash('error', 'Failed to update booking');
        res.redirect('/bookings');
    }
}));

// Cancel booking
router.delete('/:id', isLoggedIn, wrapAsync(async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id)
            .populate('listing')
            .populate('user');

        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('/bookings');
        }

        // Check if user is authorized to cancel this booking
        if (!booking.user._id.equals(req.user._id)) {
            req.flash('error', 'You are not authorized to cancel this booking');
            return res.redirect('/bookings');
        }

        // Check if booking is already cancelled
        if (booking.status === 'cancelled') {
            req.flash('error', 'Booking is already cancelled');
            return res.redirect('/bookings');
        }

        // Update booking status
        booking.status = 'cancelled';
        booking.paymentStatus = 'refunded';
        await booking.save();

        // Remove the booking dates from listing using the model method
        const listing = await Listing.findById(booking.listing._id);
        if (listing) {
            await listing.removeBookedDates(booking._id);
        }

        // Get host information
        const host = await User.findById(booking.listing.owner);

        // Send cancellation emails
        await sendBookingCancellationEmails(booking, booking.listing, booking.user, host);

        req.flash('success', 'Booking cancelled successfully');
        res.redirect('/bookings');
    } catch (error) {
        console.error('Error cancelling booking:', error);
        req.flash('error', 'Failed to cancel booking');
        res.redirect('/bookings');
    }
}));

// Host cancel booking
router.delete('/:id/host-cancel', isLoggedIn, wrapAsync(async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id)
            .populate('listing')
            .populate('user');
            
        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('/listings');
        }
        
        // Check if the current user is the host
        if (booking.listing.owner.toString() !== req.user._id.toString()) {
            req.flash('error', 'You do not have permission to cancel this booking');
            return res.redirect('/listings');
        }

        // Check if booking is already cancelled
        if (booking.status === 'cancelled') {
            req.flash('error', 'Booking is already cancelled');
            return res.redirect('/listings');
        }
        
        // Update booking status
        booking.status = 'cancelled';
        booking.paymentStatus = 'refunded';
        await booking.save();

        // Remove the booking dates from listing using the model method
        const listing = await Listing.findById(booking.listing._id);
        if (listing) {
            await listing.removeBookedDates(booking._id);
        }
        
        // Get host information
        const host = await User.findById(booking.listing.owner);

        // Send cancellation emails
        await sendBookingCancellationEmails(booking, booking.listing, booking.user, host);

        req.flash('success', 'Booking cancelled successfully. The guest has been notified.');
        res.redirect('/listings');
    } catch (error) {
        console.error('Error cancelling booking:', error);
        req.flash('error', 'Failed to cancel booking');
        res.redirect('/listings');
    }
}));

// Update booking status when stay is completed
router.post('/:id/complete', isLoggedIn, wrapAsync(async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id)
            .populate('listing');
            
        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('/bookings');
        }
        
        // Check if the current user is the host
        if (booking.listing.owner.toString() !== req.user._id.toString()) {
            req.flash('error', 'You do not have permission to complete this booking');
            return res.redirect('/listings');
        }
        
        // Update booking status
        booking.status = 'completed';
        await booking.save();
        
        req.flash('success', 'Booking marked as completed.');
        res.redirect('/listings');
    } catch (error) {
        console.error('Error completing booking:', error);
        req.flash('error', 'Failed to complete booking');
        res.redirect('/listings');
    }
}));

// Route to free up blocked dates
router.post('/:id/free-dates', isLoggedIn, async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        
        if (!booking) {
            req.flash('error', 'Booking not found');
            return res.redirect('/bookings');
        }

        // Check if user is authorized
        if (!booking.author.equals(req.user._id) && !booking.listing.owner.equals(req.user._id)) {
            req.flash('error', 'You are not authorized to perform this action');
            return res.redirect('/bookings');
        }

        // Remove booking dates from listing
        const listing = await Listing.findById(booking.listing);
        if (listing) {
            await listing.removeBookedDates(booking.checkIn, booking.checkOut, booking._id);
        }

        // Update booking status
        booking.status = 'cancelled';
        await booking.save();

        req.flash('success', 'Dates have been freed up successfully');
        res.redirect('/bookings');
    } catch (error) {
        console.error('Error freeing up dates:', error);
        req.flash('error', 'Failed to free up dates');
        res.redirect('/bookings');
    }
});

module.exports = router; 