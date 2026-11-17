const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@db:5432/vacation_booking",
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/**
 * Normalize date strings for accurate matching (extract numbers and dashes).
 */
function normalizeDateStr(str) {
  if (!str) return "";
  const matches = str.toString().match(/[\d\-]+/);
  return matches
    ? matches[0]
    : str.toString().replace(/\s+/g, "").toLowerCase();
}

function getTargetMonthStr(monthIndex) {
  const safeIdx = Math.max(0, Math.min(11, parseInt(monthIndex, 10) || 0));
  return MONTH_NAMES[safeIdx];
}

function stripAdminSuffix(name) {
  return (name || "").toString().replace(/\s*\(admin\)$/i, "").trim();
}

/**
 * 1. LOGIN USER
 */
async function loginUser(initialName, employeeNo) {
  if (!initialName || !employeeNo) {
    throw new Error("กรุณากรอกข้อมูลให้ครบถ้วน");
  }

  const cleanInitialInput = initialName.toString().trim().toLowerCase();
  const cleanEmpNoInput = employeeNo.toString().trim();

  // Admin master password check (matches Code.gs)
  const isMasterPass =
    cleanEmpNoInput.toLowerCase() === "admin@1423" ||
    cleanEmpNoInput === "423110" ||
    cleanEmpNoInput === "502110" ||
    cleanEmpNoInput === "331110";

  if (
    (cleanInitialInput === "admin" || cleanInitialInput === "aaf2") &&
    isMasterPass
  ) {
    return {
      success: true,
      employeeNo: cleanEmpNoInput,
      initialName: initialName.toString().trim().toUpperCase(),
      employeeThai: "ผู้ดูแลระบบ (Admin)",
      employeeEnglish: "Administrator",
      position: "Admin",
      team: "A",
      concourse: "C",
      isAdmin: true,
    };
  }

  const { rows } = await pool.query(
    `SELECT employee_no, initial_name, employee_thai, employee_english, position, team, concourse, is_admin
     FROM employees
     WHERE LOWER(TRIM(initial_name)) = $1 AND TRIM(employee_no) = $2
     LIMIT 1`,
    [cleanInitialInput, cleanEmpNoInput]
  );

  if (rows.length === 0) {
    throw new Error("รหัสพนักงาน หรือ Initial Name ไม่ถูกต้อง");
  }

  const emp = rows[0];
  const result = {
    success: true,
    employeeNo: emp.employee_no,
    initialName: emp.initial_name,
    employeeThai: emp.employee_thai,
    employeeEnglish: emp.employee_english,
    position: emp.position,
    team: emp.team,
    concourse: emp.concourse || "",
  };
  if (emp.is_admin) {
    result.isAdmin = true;
  }
  return result;
}

/**
 * 2. FETCH BOOKING SLOTS
 */
async function fetchBookings(position, team, monthIndex, year) {
  const monthIdx = parseInt(monthIndex, 10);
  const isAllMonths = isNaN(monthIdx) || monthIdx < 0;
  const targetMonthStr = isAllMonths ? "" : getTargetMonthStr(monthIdx);
  const targetTeamStr = team ? team.toString().trim().toUpperCase() : "";
  const isAllTeams = targetTeamStr === "ALL" || targetTeamStr === "";

  const conditions = [];
  const params = [];

  if (!isAllTeams) {
    params.push(targetTeamStr);
    conditions.push(`team = $${params.length}`);
  }
  if (!isAllMonths) {
    params.push(targetMonthStr);
    conditions.push(`month = $${params.length}`);
  }
  if (year && !isNaN(parseInt(year, 10))) {
    params.push(parseInt(year, 10));
    conditions.push(`year = $${params.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT id, team, year, month, date_range, name_c, name_f
     FROM booking_slots
     ${whereClause}
     ORDER BY id ASC`,
    params
  );

  const slots = [];
  for (const row of rows) {
    slots.push({
      rowNum: row.id,
      year: row.year,
      month: row.month,
      team: row.team,
      concourse: "C",
      dateRange: row.date_range,
      initialName: row.name_c || "",
      position: "Operator",
    });
    slots.push({
      rowNum: row.id,
      year: row.year,
      month: row.month,
      team: row.team,
      concourse: "F",
      dateRange: row.date_range,
      initialName: row.name_f || "",
      position: "Operator",
    });
  }

  return slots;
}

/**
 * 5. GET USER YEAR BOOKING COUNT
 */
async function getUserYearBookingCount(team, year, initialName, dbClient = pool) {
  const targetTeamStr = team ? team.toString().trim().toUpperCase() : "";
  const isAllTeams = targetTeamStr === "ALL" || targetTeamStr === "";
  const cleanInitialName = (initialName || "").toString().trim().toLowerCase();

  const conditions = [];
  const params = [];

  if (!isAllTeams) {
    params.push(targetTeamStr);
    conditions.push(`team = $${params.length}`);
  }
  if (year && !isNaN(parseInt(year, 10))) {
    params.push(parseInt(year, 10));
    conditions.push(`year = $${params.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await dbClient.query(
    `SELECT name_c, name_f FROM booking_slots ${whereClause}`,
    params
  );

  let count = 0;
  for (const row of rows) {
    const baseC = stripAdminSuffix(row.name_c).toLowerCase();
    const baseF = stripAdminSuffix(row.name_f).toLowerCase();
    if (baseC === cleanInitialName || baseF === cleanInitialName) {
      count++;
    }
  }
  return count;
}

/**
 * 3. SUBMIT BOOKING
 */
async function submitBooking(
  position,
  team,
  monthIndex,
  year,
  dateRange,
  concourse,
  initialName,
  employeeEnglish,
  isBookedByAdmin
) {
  const cleanPos = position ? position.toString().trim() : "";
  const cleanInit = initialName ? initialName.toString().trim().toUpperCase() : "";
  const adminFlag = isBookedByAdmin === true || isBookedByAdmin === "true";

  if (!adminFlag && (cleanPos === "Admin" || cleanInit === "ADMIN" || cleanInit === "AAF2")) {
    throw new Error("บัญชี Admin ต้องระบุชื่อพนักงานเพื่อจองแทน");
  }

  const targetMonthStr = getTargetMonthStr(monthIndex);
  const targetTeamStr = team ? team.toString().trim().toUpperCase() : "";
  const targetYear = parseInt(year, 10);
  const cleanInputDate = normalizeDateStr(dateRange);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id, date_range, name_c, name_f
       FROM booking_slots
       WHERE team = $1 AND month = $2 AND year = $3
       FOR UPDATE`,
      [targetTeamStr, targetMonthStr, targetYear]
    );

    const matchedRow = rows.find(
      (r) => normalizeDateStr(r.date_range) === cleanInputDate
    );

    if (!matchedRow) {
      throw new Error(
        `ไม่พบช่วงวันในตารางระบบสำหรับทีม ${team} (${targetMonthStr} ${year} - ${dateRange})`
      );
    }

    const quotaInitialName = stripAdminSuffix(initialName);
    const userYearBookings = await getUserYearBookingCount(
      team,
      year,
      quotaInitialName,
      client
    );
    if (userYearBookings >= 5) {
      throw new Error(
        `ไม่สามารถจองได้ เนื่องจากคุณได้จองวันพักร้อนครบกำหนดสูงสุด 5 ช่วงเวลาสำหรับปี ค.ศ. ${year} แล้ว`
      );
    }

    const colName = concourse === "C" ? "name_c" : "name_f";
    const currentOccupant = (matchedRow[colName] || "").toString().trim();
    if (currentOccupant !== "") {
      throw new Error(
        `ช่วงวันลาฝั่ง Concourse ${concourse} นี้ถูกจองไปแล้วโดย ${currentOccupant}`
      );
    }

    await client.query(
      `UPDATE booking_slots SET ${colName} = $1 WHERE id = $2`,
      [initialName, matchedRow.id]
    );

    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 4. CANCEL BOOKING
 */
async function cancelBooking(
  position,
  team,
  monthIndex,
  year,
  dateRange,
  concourse,
  initialName,
  targetRowNum
) {
  const targetMonthStr = getTargetMonthStr(monthIndex);
  const targetTeamStr = team ? team.toString().trim().toUpperCase() : "";
  const targetYear = parseInt(year, 10);
  const cleanInputDate = normalizeDateStr(dateRange);
  const cleanPos = position ? position.toString().trim().toLowerCase() : "";
  const cleanUser = initialName ? initialName.toString().trim().toLowerCase() : "";
  const isAdmin =
    cleanPos === "admin" ||
    cleanPos === "administrator" ||
    cleanUser === "admin" ||
    cleanUser === "aaf2" ||
    cleanUser.includes("admin");

  const colName = concourse === "C" ? "name_c" : "name_f";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let targetRow = null;
    const parsedRowNum = parseInt(targetRowNum, 10);

    if (!isNaN(parsedRowNum) && parsedRowNum > 0) {
      const { rows } = await client.query(
        `SELECT id, team, year, month, date_range, name_c, name_f
         FROM booking_slots WHERE id = $1 FOR UPDATE`,
        [parsedRowNum]
      );
      if (rows.length > 0) targetRow = rows[0];
    }

    // Pass 1: exact team, month, year, dateRange
    if (!targetRow && targetTeamStr) {
      const { rows } = await client.query(
        `SELECT id, team, year, month, date_range, name_c, name_f
         FROM booking_slots
         WHERE team = $1 AND month = $2 AND year = $3
         FOR UPDATE`,
        [targetTeamStr, targetMonthStr, targetYear]
      );
      targetRow =
        rows.find((r) => normalizeDateStr(r.date_range) === cleanInputDate) ||
        null;
    }

    // Pass 2: across all teams for matching month, year, dateRange with active booking
    if (!targetRow) {
      const { rows } = await client.query(
        `SELECT id, team, year, month, date_range, name_c, name_f
         FROM booking_slots
         WHERE month = $1 AND year = $2
         FOR UPDATE`,
        [targetMonthStr, targetYear]
      );
      targetRow =
        rows.find(
          (r) =>
            normalizeDateStr(r.date_range) === cleanInputDate &&
            (r[colName] || "").trim() !== ""
        ) || null;

      // Pass 3: broad fallback for month & concourse matching user or admin
      if (!targetRow) {
        targetRow =
          rows.find((r) => {
            const cellVal = (r[colName] || "").trim().toLowerCase();
            if (!cellVal) return false;
            return (
              isAdmin ||
              cellVal.includes(cleanUser) ||
              cleanUser.includes(cellVal)
            );
          }) || null;
      }
    }

    if (!targetRow) {
      throw new Error(
        `ไม่พบรายการจองนี้ในระบบ (เดือน: ${targetMonthStr} ${year}, ช่วงวัน: ${dateRange})`
      );
    }

    const occupant = (targetRow[colName] || "").toString().trim();
    const cleanOccupant = occupant.toLowerCase();

    if (
      !isAdmin &&
      cleanOccupant &&
      cleanOccupant !== cleanUser &&
      !cleanOccupant.includes(cleanUser) &&
      !cleanUser.includes(cleanOccupant)
    ) {
      throw new Error(
        `คุณไม่มีสิทธิ์ยกเลิกการจองของพนักงานท่านอื่น (${occupant})`
      );
    }

    await client.query(`UPDATE booking_slots SET ${colName} = '' WHERE id = $1`, [
      targetRow.id,
    ]);

    await client.query("COMMIT");
    return { success: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 6. GET USER BOOKING HISTORY
 */
async function getUserBookingHistory(team, initialName) {
  const result = { personalLogs: [] };
  const cleanInitial = (initialName || "").toString().trim().toLowerCase();
  const targetTeamStr = team ? team.toString().trim().toUpperCase() : "";
  const isAllTeams = targetTeamStr === "ALL" || targetTeamStr === "";

  const { rows } = await pool.query(
    `SELECT id, team, year, month, date_range, name_c, name_f
     FROM booking_slots
     ${!isAllTeams ? "WHERE team = $1" : ""}
     ORDER BY id ASC`,
    !isAllTeams ? [targetTeamStr] : []
  );

  for (const row of rows) {
    if (row.name_c && row.name_c.trim()) {
      const cleanC = row.name_c.trim().toLowerCase();
      if (stripAdminSuffix(cleanC) === cleanInitial) {
        const bookedByAdmin = /\(admin\)/i.test(cleanC);
        result.personalLogs.push({
          id: `SCH-C-${row.id}`,
          empName: row.name_c.trim(),
          position: "Operator",
          team: row.team,
          concourse: "C",
          monthYear: `${row.month} ${row.year}`,
          dateRange: row.date_range,
          timestamp: bookedByAdmin ? "จองโดย Admin" : "อนุมัติแล้ว",
          isOwner: true,
        });
      }
    }
    if (row.name_f && row.name_f.trim()) {
      const cleanF = row.name_f.trim().toLowerCase();
      if (stripAdminSuffix(cleanF) === cleanInitial) {
        const bookedByAdmin = /\(admin\)/i.test(cleanF);
        result.personalLogs.push({
          id: `SCH-F-${row.id}`,
          empName: row.name_f.trim(),
          position: "Operator",
          team: row.team,
          concourse: "F",
          monthYear: `${row.month} ${row.year}`,
          dateRange: row.date_range,
          timestamp: bookedByAdmin ? "จองโดย Admin" : "อนุมัติแล้ว",
          isOwner: true,
        });
      }
    }
  }

  return result;
}

/**
 * 7. GET ALL BOOKINGS HISTORY
 */
async function getAllBookingsHistory() {
  const result = { adminLogs: [] };
  const { rows } = await pool.query(
    `SELECT id, team, year, month, date_range, name_c, name_f
     FROM booking_slots
     WHERE TRIM(name_c) <> '' OR TRIM(name_f) <> ''
     ORDER BY id ASC`
  );

  for (const row of rows) {
    if (row.name_c && row.name_c.trim()) {
      result.adminLogs.push({
        id: `ADM-C-${row.id}`,
        empName: row.name_c.trim(),
        position: "Operator",
        team: row.team,
        concourse: "C",
        monthYear: `${row.month} ${row.year}`,
        dateRange: row.date_range,
        timestamp: "อนุมัติแล้ว",
      });
    }
    if (row.name_f && row.name_f.trim()) {
      result.adminLogs.push({
        id: `ADM-F-${row.id}`,
        empName: row.name_f.trim(),
        position: "Operator",
        team: row.team,
        concourse: "F",
        monthYear: `${row.month} ${row.year}`,
        dateRange: row.date_range,
        timestamp: "อนุมัติแล้ว",
      });
    }
  }

  return result;
}

/**
 * 8. CLEAR ADMIN BOOKINGS (by team & month)
 */
async function clearAdminBookings(targetTeam, targetMonth) {
  const cleanTargetTeam = targetTeam
    ? targetTeam.toString().trim().toUpperCase()
    : "A";
  const cleanTargetMonth = targetMonth
    ? targetMonth.toString().trim().toUpperCase()
    : "JAN";

  const { rows } = await pool.query(
    `SELECT id, name_c, name_f FROM booking_slots WHERE team = $1 AND month = $2`,
    [cleanTargetTeam, cleanTargetMonth]
  );

  let clearedCount = 0;
  for (const r of rows) {
    if (r.name_c && r.name_c.trim()) clearedCount++;
    if (r.name_f && r.name_f.trim()) clearedCount++;
  }

  await pool.query(
    `UPDATE booking_slots SET name_c = '', name_f = '' WHERE team = $1 AND month = $2`,
    [cleanTargetTeam, cleanTargetMonth]
  );

  return { success: true, clearedCount };
}

/**
 * 9. CLEAR ALL ADMIN BOOKINGS (containing '(Admin)')
 */
async function clearAllAdminBookings() {
  const { rows } = await pool.query(
    `SELECT id, name_c, name_f FROM booking_slots WHERE name_c ~* '\\(admin\\)' OR name_f ~* '\\(admin\\)'`
  );

  let count = 0;
  for (const r of rows) {
    if (/\(admin\)/i.test(r.name_c || "")) count++;
    if (/\(admin\)/i.test(r.name_f || "")) count++;
  }

  await pool.query(
    `UPDATE booking_slots SET name_c = '' WHERE name_c ~* '\\(admin\\)'`
  );
  await pool.query(
    `UPDATE booking_slots SET name_f = '' WHERE name_f ~* '\\(admin\\)'`
  );

  return { success: true, count };
}

/**
 * 10. CLEAR ALL TABLE BOOKINGS
 */
async function clearAllTableBookings() {
  const res = await pool.query(
    `UPDATE booking_slots SET name_c = '', name_f = ''`
  );
  return { success: true, count: res.rowCount };
}

async function handleAction(params) {
  const action = params.action;
  switch (action) {
    case "loginUser":
      return loginUser(params.initialName, params.employeeNo);
    case "fetchBookings":
      return fetchBookings(
        params.position,
        params.team,
        params.monthIndex,
        params.year
      );
    case "getUserYearBookingCount":
      return getUserYearBookingCount(
        params.team,
        params.year,
        params.initialName
      );
    case "getUserBookingHistory":
      return getUserBookingHistory(params.team, params.initialName);
    case "getAllBookingsHistory":
      return getAllBookingsHistory();
    case "clearAllTableBookings":
      return clearAllTableBookings();
    case "clearAllAdminBookings":
      return clearAllAdminBookings();
    case "clearAdminBookings":
      return clearAdminBookings(params.team, params.month);
    case "submitBooking":
      return submitBooking(
        params.position,
        params.team,
        params.monthIndex,
        params.year,
        params.dateRange,
        params.concourse,
        params.initialName,
        params.employeeEnglish,
        params.isBookedByAdmin
      );
    case "cancelBooking":
      return cancelBooking(
        params.position,
        params.team,
        params.monthIndex,
        params.year,
        params.dateRange,
        params.concourse,
        params.initialName,
        params.rowNum
      );
    default:
      throw new Error(`Invalid action: ${action}`);
  }
}

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api", async (req, res) => {
  try {
    if (!req.query.action) {
      return res.json({
        success: true,
        message: "AZ Vacation Booking PostgreSQL API is running.",
      });
    }
    const data = await handleAction(req.query);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api", async (req, res) => {
  try {
    const params = req.body || {};
    const data = await handleAction(params);
    res.json({ success: true, data });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
  console.log(`AZ Vacation Booking server running on http://localhost:${PORT}`);
});
