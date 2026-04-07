require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const path = require('path');

const app = express();app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

const CONSULTANT_CALENDARS = {
  'Alicia': 'c_4630b56e39c22442b2f61124a084627b26197e224c1c8c7bc96390b69d79c82a@group.calendar.google.com',
  'Lisa': 'lisa@littleblindspot.com',
  'Ashley': 'c_739ffd92602eef573f90e750d3755724a4decb5dacdb4989dc6eb81ac6dba997@group.calendar.google.com',
  'Nancy': 'nancy@littleblindspot.com',
  'Linda': 'c_g8qe7fr7n89mbho19fb4b7idag@group.calendar.google.com',
  'Alaina': 'c_c928b7dfcdb9f92a8f66d602310132748b92b8faf5e99c5321f92bf35534eab4@group.calendar.google.com',
  'Amber Roehrs': 'amber@littleblindspot.com'
};

const ZONE_CENTERS = {
  'northwest': { lat: 45.07, lng: -93.46, label: 'Northwest (Maple Grove area)' },
  'west lake': { lat: 44.97, lng: -93.51, label: 'West Lake (Wayzata area)' },
  'southwest': { lat: 44.85, lng: -93.46, label: 'Southwest (Eden Prairie area)' },
  'south': { lat: 44.76, lng: -93.28, label: 'South (Burnsville area)' },
  'central': { lat: 44.98, lng: -93.27, label: 'Central (Minneapolis/Edina area)' }
};

const ZONE_RADIUS_MILES = 12;

function milesBetween(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getZoneFromCoords(lat, lng) {
  let closest = null;
  let closestDist = Infinity;
  for (const [zone, center] of Object.entries(ZONE_CENTERS)) {
    const dist = milesBetween(lat, lng, center.lat, center.lng);
    if (dist < ZONE_RADIUS_MILES && dist < closestDist) {
      closest = zone;
      closestDist = dist;
    }
  }
  return closest;
}

async function geocodeAddress(address) {
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    console.log('Geocoding address:', address, '| Key present:', !!key);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
    const res = await fetch(url);
    const data = await res.json();
    console.log('Geocode result status:', data.status, '| Results:', data.results?.length || 0);
    if (data.results && data.results.length > 0) {
      const { lat, lng } = data.results[0].geometry.location;
      console.log('Geocoded to:', lat, lng);
      return { lat, lng };
    }
  } catch (e) {
    console.error('Geocode error:', e.message);
  }
  return null;
}

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.REDIRECT_URI || 'https://lbs-lead-intake-production.up.railway.app/auth/callback'
  );
}

function getAuthedClient(req) {
  const client = getOAuthClient();
  if (!req.session.tokens) return null;
  client.setCredentials(req.session.tokens);
  return client;
}

app.get('/auth', (req, res) => {
  const client = getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events'
    ]
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(req.query.code);
    req.session.tokens = tokens;
    res.redirect('/?authed=1');
  } catch (e) {
    console.error('Auth error:', e);
    res.redirect('/?error=auth');
  }
});

app.get('/api/homeval', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.json({ value: null });
  try {
    const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}&limit=1`;
    const response = await fetch(url, {
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY }
    });
    const data = await response.json();
    console.log('Rentcast response:', JSON.stringify(data).slice(0, 500));
    if (data && data.length > 0) {
      const prop = data[0];
      const value = prop.estimatedValue || prop.lastSalePrice || prop.price || null;
      return res.json({ value });
    }
    res.json({ value: null });
  } catch (e) {
    console.error('Homeval error:', e);
    res.json({ value: null });
  }
});

app.get('/api/geocode', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.json({ lat: null, lng: null });
  const coords = await geocodeAddress(address);
  res.json(coords || { lat: null, lng: null });
});

app.get('/api/places', async (req, res) => {
  const { input } = req.query;
  if (!input) return res.json({ predictions: [] });
  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=address&components=country:us&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json({ predictions: data.predictions || [] });
  } catch (e) {
    console.error('Places error:', e.message);
    res.json({ predictions: [] });
  }
});

app.get('/api/slots', async (req, res) => {
  const auth = getAuthedClient(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const { consultants, date_range = 14, address } = req.query;
  if (!consultants) return res.json({});

  const names = consultants.split(',').map(n => n.trim());
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const timeMin = new Date(now);
  timeMin.setHours(now.getHours() + 1, 0, 0, 0);
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + parseInt(date_range));

  // Geocode the new appointment address for zone comparison
  let newAppointmentZone = null;
  if (address) {
    const coords = await geocodeAddress(address);
    if (coords) newAppointmentZone = getZoneFromCoords(coords.lat, coords.lng);
  }

  const results = {};

  for (const name of names) {
    const calId = CONSULTANT_CALENDARS[name];
    if (!calId) { results[name] = { slots: [], zoneWarnings: {} }; continue; }

    try {
      // Get freebusy
      const freebusyRes = await calendar.freebusy.query({
        requestBody: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          timeZone: 'America/Chicago',
          items: [{ id: calId }]
        }
      });

      const busy = freebusyRes.data.calendars[calId]?.busy || [];

      // Get existing events to check locations for zone conflicts
      const eventsRes = await calendar.events.list({
        calendarId: calId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      // Build a map of date -> existing appointment zones
      const dateZoneMap = {};
      for (const event of (eventsRes.data.items || [])) {
        if (!event.location) continue;
        const eventDate = new Date(event.start.dateTime || event.start.date)
          .toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
        const coords = await geocodeAddress(event.location);
        if (coords) {
          const zone = getZoneFromCoords(coords.lat, coords.lng);
          if (zone) {
            if (!dateZoneMap[eventDate]) dateZoneMap[eventDate] = [];
            dateZoneMap[eventDate].push({ zone, location: event.location, title: event.summary });
          }
        }
      }

      const slots = [];
      const zoneWarnings = {};

      const current = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      current.setMinutes(0, 0, 0);
      current.setHours(current.getHours() + 1);

      const todayChicago = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));

      while (current < timeMax && slots.length < 6) {
        const chicagoTime = new Date(current.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
        const day = chicagoTime.getDay();
        const hour = chicagoTime.getHours();

        const isToday = chicagoTime.getDate() === todayChicago.getDate() &&
          chicagoTime.getMonth() === todayChicago.getMonth() &&
          chicagoTime.getFullYear() === todayChicago.getFullYear();

        if (!isToday && day >= 1 && day <= 5 && hour >= 9 && hour <= 15) {
          const slotEnd = new Date(current);
          slotEnd.setHours(slotEnd.getHours() + 2);

          const conflict = busy.some(b => {
            const bStart = new Date(b.start);
            const bEnd = new Date(b.end);
            bStart.setHours(bStart.getHours() - 1);
            bEnd.setHours(bEnd.getHours() + 1);
            return current < bEnd && slotEnd > bStart;
          });

          if (!conflict) {
            slots.push(current.toISOString());

            // Check zone conflict for this slot's date
            if (newAppointmentZone) {
              const slotDate = chicagoTime.toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
              const existingZones = dateZoneMap[slotDate];
              if (existingZones && existingZones.length > 0) {
                const conflictingZone = existingZones.find(z => z.zone !== newAppointmentZone);
                if (conflictingZone) {
                  zoneWarnings[current.toISOString()] = `${name} has an existing appointment in ${ZONE_CENTERS[conflictingZone.zone].label} — this appointment is in a different area`;
                }
              }
            }
          }
        }

        current.setHours(current.getHours() + 1);

        const nextChicago = new Date(current.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
        if (nextChicago.getHours() >= 17) {
          current.setDate(current.getDate() + 1);
          const tomorrow = new Date(current.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
          current.setHours(current.getHours() + (9 - tomorrow.getHours()), 0, 0, 0);
        }
      }

      results[name] = { slots, zoneWarnings };
    } catch (e) {
      console.error(`Slots error for ${name}:`, e.message);
      results[name] = { slots: [], zoneWarnings: {} };
    }
  }

  res.json(results);
});

app.post('/api/book', async (req, res) => {
  const auth = getAuthedClient(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const {
    consultant, slot, address, homeValue, tier, scope, driver,
    specialties, notes, bookedBy, customerName, phone, email,
    leadSource, consultantTitle, customerTitle
  } = req.body;

  const calId = CONSULTANT_CALENDARS[consultant];
  if (!calId) return res.status(400).json({ error: 'Unknown consultant' });

  const calendar = google.calendar({ version: 'v3', auth });
  const start = new Date(slot);
  const end = new Date(start);
  end.setHours(end.getHours() + 2);

  const scopeLabels = {
    'whole-home': 'Whole home / multi-room',
    'few-rooms': 'A few rooms',
    'one-room': 'One room or a few windows'
  };
  const driverLabels = {
    'new-build': 'New build',
    'remodel': 'Full remodel',
    'refresh': 'Refresh / update',
    'browsing': 'Exploring options'
  };

  const consultantDescription = [
    `Customer: ${customerName}`,
    `Phone: ${phone}`,
    email ? `Email: ${email}` : null,
    `Address: ${address}`,
    `Est. home value: ${homeValue || '—'}`,
    `Lead source: ${leadSource || '—'}`,
    `Project tier: ${tier}`,
    `Scope: ${scopeLabels[scope] || scope}`,
    `Project driver: ${driverLabels[driver] || driver}`,
    `Specialties: ${specialties}`,
    `Booked by: ${bookedBy}`,
    notes ? `Notes: ${notes}` : null
  ].filter(Boolean).join('\n');

  const customerDescription = [
    `Your design consultant will come to you — to your home, your rooms, your actual windows in your actual light. Plan for about an hour, though it often goes a bit longer.`,
    ``,
    `Here's how it typically goes:`,
    `• We listen first. You'll walk us through the spaces and tell us what's working, what isn't, and how you use each room.`,
    `• We bring samples. Your consultant will have Hunter Douglas materials on hand so you can see and feel options in your own space.`,
    `• We make recommendations. Based on your light, architecture, and lifestyle, we'll suggest what we'd actually do — with honest reasoning behind it.`,
    `• We measure. Every window gets precise measurements so your quote reflects exactly what you'd be ordering.`,
    `• You'll leave with a clear picture. No pressure to decide on the spot.`,
    ``,
    `If your partner or spouse will be involved in the decision, this is a great appointment for both of you to join.`,
    ``,
    `Questions? Call us at (612) 555-0100.`
  ].join('\n');

  try {
    await calendar.events.insert({
      calendarId: calId,
      requestBody: {
        summary: consultantTitle,
        description: consultantDescription,
        location: address,
        start: { dateTime: start.toISOString(), timeZone: 'America/Chicago' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' }
      }
    });

    if (email) {
      await calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary: customerTitle,
          description: customerDescription,
          location: address,
          start: { dateTime: start.toISOString(), timeZone: 'America/Chicago' },
          end: { dateTime: end.toISOString(), timeZone: 'America/Chicago' },
          attendees: [{ email }]
        }
      });
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
