// engine/control/calendar.js
// GAME TIME + calendar — the clock the whole farm sim runs on (Stardew-style).
// makeCalendar(cfg) returns a stateful clock you feed minutes: advance(minutes)
// rolls the wall clock and returns the discrete events that crossed
// (tick / hour / dayRolled / seasonRolled / yearRolled); sleep() fast-forwards to
// the next morning. The clock runs a play-day from dayStartHour (6:00) up to
// dayEndHour (26:00 = 2am), where the farmer PASSES OUT — advancing freezes
// (api.passOut) until you sleep(). Crossing midnight (24:00) flips the DATE to the
// next day even before you sleep, matching Stardew.
//
// Pure + deterministic + node-safe: no Date/now/timers/Math.random/DOM. All state
// lives in the closure; the whole farm sim (crops, energy, saves) subscribes to
// the events this emits. Everything is plain data so it runs headless in a test.
//
//   const cal = makeCalendar();
//   for (const ev of cal.advance(600)) if (ev.type === 'hour') tickCrops(ev.hour);
//   cal.format();  // "Mon, Spring 1, 6:00"

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MINS_PER_DAY = 1440;
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

export function makeCalendar({
  dayStartHour = 6,        // farmer wakes at 6am
  dayEndHour = 26,         // 26:00 == 2am next day: pass-out deadline
  minutesPerTick = 10,     // game-minutes between 'tick' events (Stardew = 10)
  seasonDays = 28,         // days in a season
  seasons = ['spring', 'summer', 'fall', 'winter'],
  startDay = 1,            // day-of-season the save begins on (1..seasonDays)
  duskHour = 18,           // isNight past this hour (6pm sunset)
  startYear = 1,
} = {}) {
  const yearLen = seasonDays * seasons.length;
  const dayLenMin = (dayEndHour - dayStartHour) * 60;   // minutes awake before pass-out
  const dayOffset = startDay - 1;                        // shifts the epoch to startDay

  // absMin = absolute game-minutes since midnight of the epoch day (00:00).
  let absMin = (startYear - 1) * yearLen * MINS_PER_DAY + dayStartHour * 60;
  let dayStartMin = absMin;   // absMin of THIS play-day's morning (pass-out is measured from here)
  let sinceTick = 0;          // minutes accumulated toward the next 'tick'
  let pendingMin = 0;         // fractional-minute carry so real-time dt is lossless

  // Calendar breakdown for a given count of whole days elapsed since the epoch.
  function dateAt(daysElapsed) {
    const total = dayOffset + daysElapsed;
    const yr = Math.floor(total / yearLen) + 1;
    const doy = ((total % yearLen) + yearLen) % yearLen;
    const si = Math.floor(doy / seasonDays);
    return {
      day: (doy % seasonDays) + 1,
      season: seasons[si],
      seasonIndex: si,
      year: yr,
      dayOfWeek: DAY_NAMES[((total % 7) + 7) % 7],
    };
  }

  // Emit dayRolled (+ seasonRolled/yearRolled) for every midnight between prev..now.
  function rollDays(prevDays, nowDays, out) {
    for (let d = prevDays + 1; d <= nowDays; d++) {
      const cur = dateAt(d), was = dateAt(d - 1);
      out.push({ type: 'dayRolled', ...cur });
      if (cur.seasonIndex !== was.seasonIndex)
        out.push({ type: 'seasonRolled', season: cur.season, seasonIndex: cur.seasonIndex, year: cur.year });
      if (cur.year !== was.year)
        out.push({ type: 'yearRolled', year: cur.year });
    }
  }

  const api = {
    passOut: false,   // set true once dayEndHour passes; cleared by sleep()

    // Feed game-minutes; returns the events crossed, in chronological order.
    advance(minutes) {
      const out = [];
      if (api.passOut || !(minutes > 0)) return out;
      pendingMin += minutes;
      let whole = Math.floor(pendingMin);
      pendingMin -= whole;
      while (whole-- > 0) {
        const prevDays = Math.floor(absMin / MINS_PER_DAY);
        absMin += 1; sinceTick += 1;
        const wall = absMin % MINS_PER_DAY;
        if (sinceTick >= minutesPerTick) {
          sinceTick = 0;
          out.push({ type: 'tick', hour: Math.floor(wall / 60), minute: wall % 60 });
        }
        if (wall % 60 === 0) out.push({ type: 'hour', hour: Math.floor(wall / 60) });
        const nowDays = Math.floor(absMin / MINS_PER_DAY);
        if (nowDays !== prevDays) rollDays(prevDays, nowDays, out);
        if (absMin - dayStartMin >= dayLenMin) { api.passOut = true; break; }  // 2am collapse
      }
      return out;
    },

    // Fast-forward to the next dayStartHour morning; emits only the roll events.
    sleep() {
      const out = [];
      const startAbs = dayStartHour * 60;
      let target = Math.floor(absMin / MINS_PER_DAY) * MINS_PER_DAY + startAbs;
      while (target <= absMin) target += MINS_PER_DAY;     // strictly the NEXT morning
      const prevDays = Math.floor(absMin / MINS_PER_DAY);
      const nowDays = Math.floor(target / MINS_PER_DAY);
      absMin = target; dayStartMin = absMin; sinceTick = 0; pendingMin = 0;
      api.passOut = false;
      if (nowDays !== prevDays) rollDays(prevDays, nowDays, out);
      return out;
    },

    clock() {                        // wall clock, 24h
      const wall = absMin % MINS_PER_DAY;
      return { hour: Math.floor(wall / 60), minute: wall % 60 };
    },

    date() { return dateAt(Math.floor(absMin / MINS_PER_DAY)); },

    format() {
      const d = api.date(), c = api.clock();
      return `${d.dayOfWeek}, ${cap(d.season)} ${d.day}, ${c.hour}:${pad2(c.minute)}`;
    },
  };

  // isNight: dark before the morning start or once dusk passes.
  Object.defineProperty(api, 'isNight', {
    get() {
      const h = Math.floor((absMin % MINS_PER_DAY) / 60);
      return h >= duskHour || h < dayStartHour;
    },
  });

  return api;
}

export const calendar = { makeCalendar };
