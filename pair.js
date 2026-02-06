import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

// Store pairing codes temporarily
const pairingCodes = new Map();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        // Ignore errors
    }
}

// Main endpoint for pairing code
router.get('/', async (req, res) => {
    let num = req.query.num;
    
    // Agar query parameter 'num' nahi hai to check for 'number'
    if (!num) {
        num = req.query.number;
    }
    
    if (!num) {
        return res.status(400).send({
            error: 'Phone number required',
            message: 'Use: /?num=923027598014 or /?number=923027598014'
        });
    }
    
    console.log(`📱 Received request for number: ${num}`);
    
    // Remove non-digit characters
    num = num.replace(/[^0-9]/g, '');
    
    // Validate phone number
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        return res.status(400).send({
            error: 'Invalid phone number',
            message: 'Please enter a valid international number without + or spaces',
            example: '923027598014'
        });
    }
    
    // Get E.164 format without +
    const cleanNum = phone.getNumber('e164').replace('+', '');
    const sessionDir = `./session_${cleanNum}`;
    
    // Clean old session if exists
    if (fs.existsSync(sessionDir)) {
        removeFile(sessionDir);
    }
    
    try {
        // Start pairing process
        const pairingCode = await startPairingProcess(cleanNum, sessionDir);
        
        if (pairingCode) {
            // Store code temporarily
            pairingCodes.set(cleanNum, {
                code: pairingCode,
                timestamp: Date.now()
            });
            
            // Auto delete after 5 minutes
            setTimeout(() => {
                pairingCodes.delete(cleanNum);
                removeFile(sessionDir);
            }, 5 * 60 * 1000);
            
            // Return just the pairing code
            return res.send(pairingCode);
        } else {
            return res.status(500).send('Failed to get pairing code');
        }
        
    } catch (error) {
        console.error('Error in pairing:', error);
        removeFile(sessionDir);
        return res.status(500).send('Error getting pairing code');
    }
});

// Function to start pairing process
async function startPairingProcess(num, sessionDir) {
    return new Promise(async (resolve, reject) => {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            const { version } = await fetchLatestBaileysVersion();
            
            const socket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });
            
            // Store socket for later use
            const sockets = new Map();
            sockets.set(num, socket);
            
            let pairingCodeReceived = false;
            
            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection === 'open') {
                    console.log(`✅ Connected for ${num}`);
                    
                    // Clean up after sending session
                    setTimeout(() => {
                        removeFile(sessionDir);
                        sockets.delete(num);
                    }, 5000);
                }
                
                if (connection === 'close') {
                    console.log(`❌ Connection closed for ${num}`);
                    removeFile(sessionDir);
                    sockets.delete(num);
                    if (!pairingCodeReceived) {
                        reject(new Error('Connection closed before getting pairing code'));
                    }
                }
            });
            
            socket.ev.on('creds.update', saveCreds);
            
            // Request pairing code
            if (!socket.authState.creds.registered) {
                await delay(3000);
                
                try {
                    const code = await socket.requestPairingCode(num);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    
                    console.log(`📋 Pairing code for ${num}: ${formattedCode}`);
                    pairingCodeReceived = true;
                    
                    resolve(formattedCode);
                    
                } catch (pairingError) {
                    console.error(`❌ Pairing error for ${num}:`, pairingError);
                    removeFile(sessionDir);
                    sockets.delete(num);
                    reject(pairingError);
                }
            } else {
                // Already registered
                resolve('Already registered');
            }
            
        } catch (error) {
            console.error(`❌ Error starting session for ${num}:`, error);
            removeFile(sessionDir);
            reject(error);
        }
    });
}

// Additional endpoint to check if code is available
router.get('/check', (req, res) => {
    let num = req.query.num || req.query.number;
    
    if (!num) {
        return res.status(400).send({
            error: 'Phone number required',
            message: 'Use: /check?num=923027598014'
        });
    }
    
    num = num.replace(/[^0-9]/g, '');
    
    const codeData = pairingCodes.get(num);
    
    if (!codeData) {
        return res.status(404).send('No pairing code found for this number');
    }
    
    // Check if code is expired (5 minutes)
    if (Date.now() - codeData.timestamp > 5 * 60 * 1000) {
        pairingCodes.delete(num);
        return res.status(410).send('Pairing code expired');
    }
    
    res.send({
        number: num,
        pairing_code: codeData.code,
        expires_in: Math.floor((5 * 60 * 1000 - (Date.now() - codeData.timestamp)) / 1000) + ' seconds'
    });
});

// Clean up expired codes periodically
setInterval(() => {
    const now = Date.now();
    for (const [num, data] of pairingCodes.entries()) {
        if (now - data.timestamp > 5 * 60 * 1000) {
            pairingCodes.delete(num);
        }
    }
}, 60000); // Clean every minute

export default router;
