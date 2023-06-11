import * as process from 'process';
import * as path from 'path';
import * as fs from 'fs/promises';
import Humanforce from 'humanforced/humanforce.js';
import Shift from 'humanforced/shift.js';
import {authenticate} from '@google-cloud/local-auth';
import {google} from 'googleapis';
import 'dotenv/config';

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const calendarId = process.env.CALENDAR_ID;

const SYNC_INTERVAL = 1000 * 60 * parseInt(process.env.SYNC_INTERVAL_MINS ?? 10);

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

// Setup humanforce client
const humanforce = new Humanforce();
console.log('Logging in...');
await humanforce.login(EMAIL, PASSWORD);
const profile = await humanforce.getProfile();
console.log(`Logged into ${humanforce.companyName} as ${profile.fullName} (${profile.employeeCode})!`);

async function getGoogleAuth() {
    async function load() { // load OAuth client using stored token
        try {
            return google.auth.fromJSON(JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8')));
        } catch (err) {
            return null;
        }
    }

    async function save(client) { // Save OAuth client by writing token to disk
        const content = await fs.readFile(CREDENTIALS_PATH, 'utf-8');
        const keys = JSON.parse(content);
        const key = keys.installed || keys.web;
        const payload = JSON.stringify({
            type: 'authorized_user',
            client_id: key.client_id,
            client_secret: key.client_secret,
            refresh_token: client.credentials.refresh_token,
        });
        await fs.writeFile(TOKEN_PATH, payload);
    }

    // Try to load client so we don't have to reauthenticate
    let client = await load();
    if (client) return client;

    // Authenticate
    client = await authenticate({
        scopes: ['https://www.googleapis.com/auth/calendar.events.owned'],
        keyfilePath: CREDENTIALS_PATH
    });

    // Save client
    if (client.credentials) await save(client);

    return client;
}

const googleAuth = await getGoogleAuth();
const calendar = google.calendar({version: 'v3', auth: googleAuth});
let calendarEventColor = null;

/**
 * @param {Shift} shift
 */
function createShiftEventObject(shift) {
    const event = {
        summary: shift.role,
        location: '5a Corbett Ct, Adelaide Airport SA 5950',
        description: `${shift.role} @ ${shift.location}`,
        start: {
            dateTime: shift.startTime.toISOString(),
            timeZone: 'Australia/Adelaide'
        },
        end: {
            dateTime: shift.endTime.toISOString(),
            timeZone: 'Etc/UTC'
        },
        source: {
            title: 'Humanforce Sync',
            url: 'http://localhost:3000' // todo: update
        },
        extendedProperties: {
            private: {
                humanforceShiftCompany: humanforce.companyName,
                humanforceShiftGuid: shift.guid,
                humanforceShiftHash: shift.hash
            }
        }
    };

    // Set event color if known
    if (calendarEventColor) event.colorId = calendarEventColor;

    return event;
}

/**
 * @param {Shift} shift
 * @return {Promise<void>}
 */
async function addShiftEvent(shift) {
    const event = createShiftEventObject(shift);
    await calendar.events.insert({
        auth: googleAuth,
        calendarId: calendarId,
        resource: event
    });
}

/**
 * @param {string} eventId
 * @param {Shift} shift
 * @return {Promise<void>}
 */
async function updateShiftEvent(eventId, shift) {
    const event = createShiftEventObject(shift);
    await calendar.events.update({
        auth: googleAuth,
        calendarId: calendarId,
        eventId: eventId,
        resource: event
    });
}

async function cancelEvent(event) {
    event.status = 'cancelled';
    await calendar.events.update({
        auth: googleAuth,
        calendarId: calendarId,
        eventId: event.id,
        resource: event
    });
}

async function findShiftsInGoogleCalendar() {
    const response = await calendar.events.list({
        calendarId: calendarId,
        privateExtendedProperty: ['humanforceShiftCompany=' + humanforce.companyName],
        timeMin: new Date().toISOString() // we ignore shifts that have already happened (we don't want to update them)
    });

    return response.data.items;
}

async function sync() {
    console.log('Performing sync...');

    const shifts = await humanforce.getCalendar(new Date())
    const events = await findShiftsInGoogleCalendar();
    calendarEventColor = events[events.length - 1].colorId;

    // Add and update shifts
    for (const shift of shifts) {
        // Find associated event in calendar
        const event = events.find(e => e.extendedProperties.private.humanforceShiftGuid === shift.guid);

        if (!event) {
            // Event doesn't exist
            console.log(`Added shift: ${shift.role} ${shift.startTime} - ${shift.endTime}`);
            await addShiftEvent(shift);
        } else if (event.extendedProperties.private.humanforceShiftHash !== shift.hash) {
            // Event exists, but it is different to the shift provided by Humanforce
            console.log(`Updated shift: ${shift.role} ${shift.startTime} - ${shift.endTime}`);
            await updateShiftEvent(event.id, shift);
        }
    }

    // Remove shifts that no longer exist
    for (const event of events) {
        const shift = shifts.find(s => s.guid === event.extendedProperties.private.humanforceShiftGuid);
        if (!shift) {
            console.log(`Cancelling shift ${event.summary} ${event.start} - ${event.end}...`);
            await cancelEvent(event);
        }
    }

    console.log('Sync successful.');
}

while (true) {
    try {
        await sync();
    } catch (err) {
        console.error('Error syncing!', err);

        // Try to test humanforce session
        try {
            if (!(await humanforce.testSession())) {
                console.warn('Humanforce session invalid. Attempting to re-login...');
                await humanforce.login(EMAIL, PASSWORD);
                console.log('Re-login successful. Will retry sync at next sync interval.');
            }
        } catch (err) {
            console.error('Login failed!');
        }
    }

    console.log(`Next sync in ${SYNC_INTERVAL / 1000 / 60} minutes.`);
    await new Promise(resolve => setTimeout(resolve, SYNC_INTERVAL));
}
