const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;
const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;
const localBookings = new Set();

const validDays = new Set(['E Hënë', 'E Martë', 'E Mërkurë', 'E Enjte', 'E Premte', 'E Shtunë']);
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
            time TEXT NOT NULL,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (day, time)
        )
    `);
}

app.get('/api/availability', async (request, response) => {
    const day = request.query.day;
    if (!validDays.has(day)) {
        return response.status(400).json({ error: 'Ditë e pavlefshme.' });
    }

    try {
        if (!pool) {
            return response.json({
                bookedTimes: [...localBookings]
                    .filter((booking) => booking.startsWith(`${day}|`))
                    .map((booking) => booking.split('|')[1])
            });
        }
        const result = await pool.query('SELECT time FROM bookings WHERE day = $1', [day]);
        response.json({ bookedTimes: result.rows.map((row) => row.time) });
    } catch (error) {
        console.error('Availability lookup failed:', error);
        response.status(500).json({ error: 'Nuk mund të lexohen oraret.' });
    }
});

app.post('/api/bookings', async (request, response) => {
    const { day, time, name, phone, message = '' } = request.body;
    if (!validDays.has(day) || !validTimes.has(time) || !name?.trim() || !phone?.trim()) {
        return response.status(400).json({ error: 'Ju lutem plotësoni të dhënat e kërkuara.' });
    }

    try {
        if (!pool) {
            const bookingKey = `${day}|${time}`;
            if (localBookings.has(bookingKey)) {
                return response.status(409).json({ error: 'Ky orar sapo u rezervua nga një person tjetër.' });
            }
            localBookings.add(bookingKey);
            return response.status(201).json({ message: 'Rezervimi u ruajt me sukses.' });
        }
        await pool.query(
            'INSERT INTO bookings (day, time, name, phone, message) VALUES ($1, $2, $3, $4, $5)',
            [day, time, name.trim(), phone.trim(), message.trim()]
        );
        response.status(201).json({ message: 'Rezervimi u ruajt me sukses.' });
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
