-- AZ Vacation Booking PostgreSQL Schema (No PII)

CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    employee_no VARCHAR(50) NOT NULL,
    initial_name VARCHAR(50) NOT NULL,
    employee_thai VARCHAR(255) DEFAULT '',
    employee_english VARCHAR(255) DEFAULT '',
    position VARCHAR(50) DEFAULT 'Operator',
    team VARCHAR(10) DEFAULT 'A',
    concourse VARCHAR(10) DEFAULT '',
    is_admin BOOLEAN DEFAULT FALSE,
    UNIQUE (employee_no, initial_name)
);

CREATE TABLE IF NOT EXISTS booking_slots (
    id SERIAL PRIMARY KEY,
    team VARCHAR(10) NOT NULL,
    year INT NOT NULL,
    month VARCHAR(10) NOT NULL,
    date_range VARCHAR(100) NOT NULL,
    name_c VARCHAR(100) NOT NULL DEFAULT '',
    name_f VARCHAR(100) NOT NULL DEFAULT '',
    UNIQUE (team, year, month, date_range)
);

CREATE INDEX IF NOT EXISTS idx_booking_slots_lookup ON booking_slots (team, year, month);
