const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    listing: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Listing',
        required: true
    },
    author: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    checkIn: {
        type: Date,
        required: true
    },
    checkOut: {
        type: Date,
        required: true
    },
    guests: {
        type: Number,
        required: true,
        min: 1
    },
    bookingId: {
        type: String,
        required: true,
        unique: true
    },
    orderId: {
        type: String,
        required: true,
        unique: true
    },
    paymentMode: {
        type: String,
        required: true,
        enum: ['razorpay', 'card', 'upi', 'netbanking']
    },
    paymentId: {
        type: String,
        required: true
    },
    amount: {
        basePrice: {
            type: Number,
            required: true
        },
        taxes: {
            type: Number,
            required: true
        },
        total: {
            type: Number,
            required: true
        }
    },
    status: {
        type: String,
        required: true,
        enum: ['pending', 'confirmed', 'cancelled', 'completed'],
        default: 'pending'
    },
    contact: {
        email: {
            type: String,
            required: true
        },
        name: {
            type: String,
            required: true
        }
    },
    cancellationReason: {
        type: String,
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Generate booking ID before saving
bookingSchema.pre('save', async function(next) {
    if (!this.bookingId) {
        const timestamp = Date.now().toString();
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        this.bookingId = `BK${timestamp}${random}`;
    }
    next();
});

const Booking = mongoose.model('Booking', bookingSchema);

module.exports = Booking; 