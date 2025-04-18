require("dotenv").config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoDBStore = require("connect-mongo");
const methodOverride = require("method-override");
const passport = require("./config/passport");
const flash = require("connect-flash");
const ejsMate = require("ejs-mate");
const cors = require("cors");
const csrf = require('csurf');
const cookieParser = require('cookie-parser');

const User = require('./models/users');
const listingRouter = require("./routes/listing.js");
const reviewRouter = require("./routes/review.js");
const userRouter = require("./routes/userRoutes.js");
const paymentRouter = require("./routes/paymentRoutes.js");
const bookingRouter = require("./routes/bookingRoutes.js");
const chatbotRoutes = require('./routes/chatbot');
const pagesRoutes = require('./routes/pages');

const app = express();

// DB Connection
mongoose.connect(process.env.ATLASDB_URL)
  .then(() => console.log("Database connected"))
  .catch((err) => console.log("Database connection error:", err));

// Middleware
app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.locals.layout = false;  // Disable default layout
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));

// Session configuration
const store = MongoDBStore.create({
    mongoUrl: process.env.ATLASDB_URL,
    crypto: { secret: process.env.SECRET },
    touchAfter: 24 * 3600,
    autoRemove: 'interval',
    autoRemoveInterval: 10
});

store.on('error', function(error) {
    console.log('Session store error:', error);
});

const sessionOptions = {
    store,
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
};

app.use(session(sessionOptions));

// Passport configuration
app.use(passport.initialize());
app.use(passport.session());

// Configure passport to use less aggressive session handling
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id).select('_id username email');
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// Static files middleware - should be before session middleware
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true,
    lastModified: true
}));

app.use(flash());

// Add cookie parser middleware before CSRF
app.use(cookieParser(process.env.SECRET));

// Add CSRF protection
app.use(csrf({
    cookie: {
        key: '_csrf',
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// Make currentUser and CSRF token available to all templates
app.use((req, res, next) => {
    res.locals.currentUser = req.user || null;
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.csrfToken = req.csrfToken();
    
    // Set CSRF token cookie
    res.cookie('XSRF-TOKEN', req.csrfToken(), {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });
    
    next();
});

// Add logging middleware before routes
app.use((req, res, next) => {
    console.log('\n----- Incoming Request -----');
    console.log('Time:', new Date().toISOString());
    console.log('Method:', req.method);
    console.log('URL:', req.originalUrl);
    console.log('Body:', req.body);
    console.log('Session:', req.session);
    console.log('--------------------------\n');
    next();
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    if (err.code === 'EBADCSRFTOKEN') {
        console.error('CSRF Error Details:', {
            token: req.csrfToken(),
            headers: req.headers,
            body: req.body
        });
        req.flash('error', 'Security token expired. Please try again.');
        return res.redirect('/user/login');
    }
    const { statusCode = 500, message = 'Something went wrong!' } = err;
    if (process.env.NODE_ENV === 'development') {
        console.error(err);
    }
    res.status(statusCode).render('listings/error', { message });
});

// Routes
app.use("/listings", listingRouter);
app.use("/listings/:id/reviews", reviewRouter);
app.use("/", userRouter);
app.use("/payment", paymentRouter);
app.use("/bookings", bookingRouter);
app.use('/chatbot', chatbotRoutes);
app.use('/', pagesRoutes);

// Add static route for receipts
app.use("/receipts", express.static(path.join(__dirname, "receipts")));

// 404 handler with better error message
app.all("*", (req, res) => {
    res.status(404).render("listings/error", { 
        message: "Page Not Found!",
        statusCode: 404,
        suggestion: "The page you're looking for doesn't exist. Please check the URL or go back to the homepage."
    });
});

const PORT = process.env.PORT || 5000;

// Improved server error handling
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Trying port ${PORT + 1}...`);
        app.listen(PORT + 1, () => {
            console.log(`Server running on port ${PORT + 1}`);
        });
    } else {
        console.error('Server error:', err);
        process.exit(1);
    }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
    server.close(() => {
        process.exit(1);
    });
});
