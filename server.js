const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;
const localBookings = new Set();
const emailRecipient = process.env.EMAIL_TO || 'diartident@gmail.com';

const validDays = new Set(['E Hënë', 'E Martë', 'E Mërkurë', 'E Enjte', 'E Premte', 'E Shtunë']);
const dayNames = ['E Diel', 'E Hënë', 'E Martë', 'E Mërkurë', 'E Enjte', 'E Premte', 'E Shtunë'];
const validTimes = new Set(Array.from({ length: 11 }, (_, index) => {
    const start = String(index + 9).padStart(2, '0');
    const end = String(index + 10).padStart(2, '0');
    return `${start}:00–${end}:00`;
}));

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (request, response) => {
    response.sendFile(path.join(__dirname, 'diarti.html'));
});

async function initializeDatabase() {
    if (!pool) {
        console.warn('DATABASE_URL is not set. Using temporary local storage.');
        return;
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bookings (
            id SERIAL PRIMARY KEY,
            day TEXT NOT NULL,
            booking_date DATE,
            time TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (day, time)
        )
    `);
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_date DATE');
    await pool.query('ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_day_time_key');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS bookings_date_time_key ON bookings (booking_date, time)');
}

async function sendBookingEmail({ day, date, time, name, phone, message }) {
    const emailResponse = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(emailRecipient)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({
            _subject: 'Kërkesë e re për termin - Diarti Dent',
            _captcha: 'false',
            _template: 'table',
            day,
            date,
            time,
            name,
            phone,
            message: message || ''
        })
    });

    const details = await emailResponse.text();
    let result;
    try {
        result = JSON.parse(details);
    } catch (error) {
        throw new Error(`FormSubmit returned invalid JSON (${emailResponse.status}): ${details.slice(0, 300)}`);
    }

    if (!emailResponse.ok || result.success !== true && result.success !== 'true') {
        throw new Error(`FormSubmit rejected the email: ${result.message || details.slice(0, 300)}`);
    }
}

app.get('/api/availability', async (request, response) => {
    const { day, date } = request.query;
    if (!validDays.has(day) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return response.status(400).json({ error: 'Ditë e pavlefshme.' });
    }

    try {
        if (!pool) {
            return response.json({
                bookedTimes: [...localBookings]
                    .filter((booking) => booking.startsWith(`${date}|`))
                    .map((booking) => booking.split('|')[1])
            });
        }
        const result = await pool.query('SELECT time FROM bookings WHERE booking_date = $1', [date]);
        response.json({ bookedTimes: result.rows.map((row) => row.time) });
    } catch (error) {
        console.error('Availability lookup failed:', error);
        response.status(500).json({ error: 'Nuk mund të lexohen oraret.' });
    }
});

app.post('/api/bookings', async (request, response) => {
    const { day, date, time, name, phone, message = '' } = request.body;
    if (!validDays.has(day) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !validTimes.has(time) || !name?.trim() || !phone?.trim()) {
        return response.status(400).json({ error: 'Ju lutem plotësoni të dhënat e kërkuara.' });
    }

    try {
        if (!pool) {
            const bookingKey = `${date}|${time}`;
            if (localBookings.has(bookingKey)) {
                return response.status(409).json({ error: 'Ky orar sapo u rezervua nga një person tjetër.' });
            }
            localBookings.add(bookingKey);
        } else {
            await pool.query(
                'INSERT INTO bookings (day, booking_date, time, name, phone, message) VALUES ($1, $2, $3, $4, $5, $6)',
                [day, date, time, name.trim(), phone.trim(), message.trim()]
            );
        }

        try {
            await sendBookingEmail({ day, date, time, name: name.trim(), phone: phone.trim(), message: message.trim() });
            response.status(201).json({ message: 'Rezervimi u ruajt dhe emaili u dërgua me sukses.' });
        } catch (emailError) {
            console.error('Booking email failed:', emailError);
            response.status(201).json({
                message: `Rezervimi u ruajt, por emaili nuk u dërgua: ${emailError.message}`,
                emailSent: false
            });
        }
    } catch (error) {
        if (error.code === '23505') {
            return response.status(409).json({ error: 'Ky orar sapo u rezervua nga një person tjetër.' });
        }
        console.error('Booking creation failed:', error);
        response.status(500).json({ error: 'Rezervimi nuk mund të ruhej.' });
    }
});

initializeDatabase()
    .then(() => app.listen(port, () => console.log(`Diarti Dent server running on port ${port}`)))
    .catch((error) => {
        console.error('Database initialization failed:', error);
        process.exit(1);
    });
