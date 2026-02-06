import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

// Session storage to manage multiple sessions
const activeSessions = new Map();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

// Clean up old sessions function
function cleanupOldSession(num) {
    const sessionDir = './session_' + num;
    if (fs.existsSync(sessionDir)) {
        removeFile(sessionDir);
    }
}

// Main pairing endpoint
router.get('/', async (req, res) => {
    try {
        let num = req.query.number;
        
        if (!num) {
            return res.status(400).send({ 
                error: 'Phone number required',
                usage: 'Add ?number=YOUR_NUMBER to URL (without + or spaces)',
                example: 'https://your-domain.com/pair?number=15551234567'
            });
        }

        // Clean the phone number
        num = num.replace(/[^0-9]/g, '');
        
        // Validate phone number
        const phone = pn('+' + num);
        if (!phone.isValid()) {
            return res.status(400).send({ 
                error: 'Invalid phone number',
                message: 'Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam) without + or spaces.'
            });
        }
        
        // Get E.164 format (without +)
        num = phone.getNumber('e164').replace('+', '');
        
        // Generate unique session directory
        const sessionDir = './session_' + num;
        
        // Clean up any existing session first
        cleanupOldSession(num);
        
        // Remove any existing session files
        if (fs.existsSync(sessionDir)) {
            removeFile(sessionDir);
        }
        
        // Send response immediately (pairing code will be sent separately)
        res.send({ 
            status: 'Processing',
            message: 'Pairing code request initiated. Please wait...',
            number: num
        });
        
        // Start pairing process in background
        initiatePairing(num, sessionDir);
        
    } catch (error) {
        console.error('Error in pairing route:', error);
        if (!res.headersSent) {
            res.status(500).send({ error: 'Internal server error' });
        }
    }
});

// Separate function for pairing process
async function initiatePairing(num, sessionDir) {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    
    try {
        const { version } = await fetchLatestBaileysVersion();
        
        // Create socket with SHAHAN as device name
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

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, isNewLogin } = update;

            if (connection === 'open') {
                console.log(`✅ Connected successfully for ${num}`);
                
                try {
                    // Read session file
                    const sessionData = fs.readFileSync(sessionDir + '/creds.json');
                    const userJid = jidNormalizedUser(num + '@s.whatsapp.net');
                    
                    // Formatted text for caption
                    const formattedText = `
┌─────── • ✠ •───────┐
        Hey I am *SHAHAN*
├─────── • ✠•───────┤
📱 *Tiktok:* @itx_ProBoy
📸 *Instagram:* itx___ProBoy
💻 *Github:* ProBoy315
🌐 *Website:* ProBoy.vercel.app

⚠️ *IMPORTANT NOTE:* ⚠️
> Do not share creds.json file with anybody
> Keep this file secure and private

┌┤✑ Thanks for using SHAHAN Bot
│└────────────┈ ⳹        
│© 2026 @ProBoy
└─────────────────┈ ⳹

🔐 *This file contains your WhatsApp session credentials.*
🛡️ *Store it safely and never share with anyone.*
                    `;

                    // Send session file
                    await socket.sendMessage(userJid, {
                        document: sessionData,
                        mimetype: 'application/json',
                        fileName: 'creds.json',
                        caption: formattedText
                    });
                    
                    console.log(`📄 Session file sent to ${num}`);
                    
                    // Clean up session
                    await delay(1000);
                    cleanupOldSession(num);
                    console.log(`🧹 Session cleaned up for ${num}`);
                    
                } catch (error) {
                    console.error(`❌ Error sending session to ${num}:`, error);
                    cleanupOldSession(num);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) {
                    console.log(`❌ Logged out for ${num}`);
                    cleanupOldSession(num);
                }
            }
        });

        socket.ev.on('creds.update', saveCreds);

        // Request pairing code if not registered
        if (!socket.authState.creds.registered) {
            await delay(3000);
            
            try {
                const pairingCode = await socket.requestPairingCode(num);
                const formattedCode = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
                
                console.log(`📱 Pairing code for ${num}: ${formattedCode}`);
                
                // Store pairing code for retrieval if needed
                activeSessions.set(num, {
                    code: formattedCode,
                    timestamp: Date.now()
                });
                
                // Auto-clean pairing code after 5 minutes
                setTimeout(() => {
                    activeSessions.delete(num);
                }, 5 * 60 * 1000);
                
            } catch (error) {
                console.error(`❌ Error getting pairing code for ${num}:`, error);
                cleanupOldSession(num);
            }
        }

    } catch (err) {
        console.error(`❌ Error initiating session for ${num}:`, err);
        cleanupOldSession(num);
    }
}

// New endpoint to get pairing code directly
router.get('/get-code', async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, '');
    
    if (!num) {
        return res.status(400).send({ 
            error: 'Phone number required',
            example: '/pair/get-code?number=15551234567'
        });
    }
    
    const sessionData = activeSessions.get(num);
    
    if (!sessionData) {
        return res.status(404).send({ 
            error: 'No active pairing session found',
            message: 'Please initiate pairing first by visiting /pair?number=YOUR_NUMBER'
        });
    }
    
    // Check if code is still valid (less than 5 minutes old)
    if (Date.now() - sessionData.timestamp > 5 * 60 * 1000) {
        activeSessions.delete(num);
        return res.status(410).send({ 
            error: 'Pairing code expired',
            message: 'Please request a new pairing code'
        });
    }
    
    res.send({
        success: true,
        number: num,
        pairing_code: sessionData.code,
        device_name: 'SHAHAN',
        expires_in: Math.floor((5 * 60 * 1000 - (Date.now() - sessionData.timestamp)) / 1000) + ' seconds'
    });
});

// Simple endpoint to just return pairing code
router.get('/code', async (req, res) => {
    const num = req.query.number?.replace(/[^0-9]/g, '');
    
    if (!num) {
        return res.send('Error: Phone number required. Use /pair/code?number=YOUR_NUMBER');
    }
    
    const sessionData = activeSessions.get(num);
    
    if (!sessionData) {
        return res.send(`No active pairing session found for ${num}. Please visit /pair?number=${num} first.`);
    }
    
    if (Date.now() - sessionData.timestamp > 5 * 60 * 1000) {
        activeSessions.delete(num);
        return res.send('Pairing code expired. Please request a new one.');
    }
    
    // Return just the pairing code in plain text
    res.send(sessionData.code);
});

// HTML interface endpoint
router.get('/web', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>SHAHAN WhatsApp Pairing</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                width: 100%;
                max-width: 500px;
                text-align: center;
            }
            h1 {
                color: #333;
                margin-bottom: 10px;
                font-size: 28px;
            }
            .device-name {
                color: #667eea;
                font-weight: bold;
                font-size: 24px;
                margin-bottom: 30px;
            }
            .input-group {
                margin-bottom: 25px;
                text-align: left;
            }
            label {
                display: block;
                margin-bottom: 8px;
                color: #555;
                font-weight: 500;
            }
            input {
                width: 100%;
                padding: 15px;
                border: 2px solid #e0e0e0;
                border-radius: 10px;
                font-size: 16px;
                transition: border 0.3s;
            }
            input:focus {
                outline: none;
                border-color: #667eea;
            }
            button {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                padding: 16px 40px;
                border-radius: 10px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                transition: transform 0.2s, box-shadow 0.2s;
                width: 100%;
            }
            button:hover {
                transform: translateY(-2px);
                box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
            }
            button:active {
                transform: translateY(0);
            }
            .instructions {
                background: #f8f9fa;
                border-radius: 10px;
                padding: 20px;
                margin-top: 30px;
                text-align: left;
                font-size: 14px;
                color: #666;
            }
            .instructions h3 {
                color: #333;
                margin-bottom: 10px;
            }
            .instructions ul {
                padding-left: 20px;
            }
            .instructions li {
                margin-bottom: 8px;
            }
            .result {
                margin-top: 20px;
                padding: 15px;
                border-radius: 10px;
                background: #e8f5e9;
                color: #2e7d32;
                display: none;
            }
            .result.error {
                background: #ffebee;
                color: #c62828;
            }
            .code-display {
                font-size: 32px;
                font-weight: bold;
                letter-spacing: 5px;
                color: #333;
                margin: 20px 0;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>WhatsApp Pairing</h1>
            <div class="device-name">Device: SHAHAN</div>
            
            <div class="input-group">
                <label for="number">Enter your WhatsApp number (without + or spaces):</label>
                <input type="text" id="number" placeholder="15551234567" value="">
            </div>
            
            <button onclick="getPairingCode()">Get Pairing Code</button>
            
            <div id="result" class="result"></div>
            
            <div class="instructions">
                <h3>📱 How to use:</h3>
                <ul>
                    <li>Enter your WhatsApp number with country code</li>
                    <li>Click "Get Pairing Code" button</li>
                    <li>Wait for the pairing code to appear</li>
                    <li>Go to WhatsApp → Linked Devices → Link a Device</li>
                    <li>Enter the 8-digit pairing code</li>
                    <li>Your session file will be sent to your WhatsApp</li>
                </ul>
                <p style="margin-top: 10px; color: #ff9800; font-weight: bold;">
                    ⚠️ Do not share your session file with anyone!
                </p>
            </div>
        </div>
        
        <script>
            async function getPairingCode() {
                const number = document.getElementById('number').value.trim();
                const resultDiv = document.getElementById('result');
                
                if (!number) {
                    showResult('Please enter a phone number', true);
                    return;
                }
                
                showResult('Getting pairing code... please wait', false);
                
                try {
                    // First initiate pairing
                    await fetch('/pair?number=' + number);
                    
                    // Wait a moment then get the code
                    setTimeout(async () => {
                        const response = await fetch('/pair/code?number=' + number);
                        const code = await response.text();
                        
                        if (code.includes('Error') || code.includes('expired') || code.includes('No active')) {
                            showResult(code, true);
                        } else {
                            resultDiv.innerHTML = \`
                                <div style="text-align: center;">
                                    <div style="margin-bottom: 10px; color: #555;">Your pairing code:</div>
                                    <div class="code-display">\${code}</div>
                                    <div style="margin-top: 15px; color: #666; font-size: 14px;">
                                        Enter this code in WhatsApp → Linked Devices
                                    </div>
                                </div>
                            \`;
                            resultDiv.style.display = 'block';
                            resultDiv.className = 'result';
                        }
                    }, 3000);
                    
                } catch (error) {
                    showResult('Error: ' + error.message, true);
                }
            }
            
            function showResult(message, isError) {
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = message;
                resultDiv.style.display = 'block';
                resultDiv.className = isError ? 'result error' : 'result';
            }
            
            // Auto-focus on input
            document.getElementById('number').focus();
        </script>
    </body>
    </html>
    `;
    
    res.send(html);
});

// Cleanup interval to remove old sessions
setInterval(() => {
    const now = Date.now();
    for (const [num, data] of activeSessions.entries()) {
        if (now - data.timestamp > 5 * 60 * 1000) {
            activeSessions.delete(num);
            cleanupOldSession(num);
        }
    }
}, 60 * 1000);

// Global error handling
process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignoreErrors = [
        "conflict", "not-authorized", "Socket connection timeout",
        "rate-overlimit", "Connection Closed", "Timed Out",
        "Value not found", "Stream Errored", "statusCode: 515",
        "statusCode: 503"
    ];
    
    if (!ignoreErrors.some(error => e.includes(error))) {
        console.log('Caught exception: ', err);
    }
});

export default router;
