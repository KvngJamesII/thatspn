const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const CONFIG = {
  telegram_bot_token: '8202874758:AAEYMWFHgD4cxWon_r3Er3b5s1d5BpqYY4c',
  telegram_chat_ids: [-1003151782333, -1003420206708, -1002733963369],
  panel_username: 'thatspn',
  panel_password: '321456',
  login_url: 'http://139.99.63.204/ints/login',
  sms_reports_url: 'http://139.99.63.204/ints/agent/SMSCDRReports',
  poll_interval: 30000, // 30 seconds
  user_name: 'SMS-OTP-Bot',
  data_dir: './data'
};

// ==================== BOT CLASS ====================
class OTPBot {
  constructor() {
    console.log('🚀 [INIT] Initializing OTP Bot...');
    this.telegramBot = null;
    this.browser = null;
    this.page = null;
    this.sentMessageHashes = new Set();
    this.pollInterval = null;
    this.healthCheckInterval = null;
    this.isPolling = false;
    this.pollCount = 0;
    this.lastSuccessfulPoll = Date.now();
    this.otpsSentCount = 0;
    this.isRunning = false;
    this.messageHashFile = path.join(CONFIG.data_dir, 'sent-messages.json');
    
    this.loadSentMessages();
  }

  log(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }

  loadSentMessages() {
    try {
      if (!fs.existsSync(CONFIG.data_dir)) {
        fs.mkdirSync(CONFIG.data_dir, { recursive: true });
        this.log('info', `📂 Created data directory: ${CONFIG.data_dir}`);
      }
      
      if (fs.existsSync(this.messageHashFile)) {
        const data = fs.readFileSync(this.messageHashFile, 'utf8');
        const hashes = JSON.parse(data);
        this.sentMessageHashes = new Set(hashes);
        this.log('info', `📂 Loaded ${this.sentMessageHashes.size} message hashes from file`);
      }
    } catch (err) {
      this.log('warn', `⚠️ Could not load messages: ${err.message}`);
    }
  }

  saveSentMessages() {
    try {
      if (!fs.existsSync(CONFIG.data_dir)) {
        fs.mkdirSync(CONFIG.data_dir, { recursive: true });
      }
      
      const hashArray = Array.from(this.sentMessageHashes).slice(-1000);
      fs.writeFileSync(this.messageHashFile, JSON.stringify(hashArray, null, 2));
      this.log('debug', `💾 Saved ${this.sentMessageHashes.size} message hashes`);
    } catch (err) {
      this.log('error', `Failed to save messages: ${err.message}`);
    }
  }

  async initializeBrowser() {
    try {
      this.log('info', '🌐 Initializing browser...');

      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled'
        ]
      });

      this.log('info', '✅ Browser launched successfully');

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1920, height: 1080 });
      await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

      this.log('info', '🔑 Navigating to login page...');
      await this.page.goto(CONFIG.login_url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 2000));

      this.log('info', '🔍 Solving captcha...');
      const captchaAnswer = await this.solveMathCaptcha();
      if (!captchaAnswer) {
        throw new Error('Could not solve captcha - no math expression found');
      }

      this.log('info', `✅ Captcha answer: ${captchaAnswer}`);

      this.log('info', '📝 Filling login form...');
      await this.page.waitForSelector('input[name="username"]', { timeout: 5000 });
      await this.page.type('input[name="username"]', CONFIG.panel_username);
      this.log('debug', `✓ Username entered: ${CONFIG.panel_username}`);
      
      await this.page.type('input[name="password"]', CONFIG.panel_password);
      this.log('debug', `✓ Password entered`);
      
      await this.page.type('input[name="capt"]', captchaAnswer.toString());
      this.log('debug', `✓ Captcha entered: ${captchaAnswer}`);

      this.log('info', '🔄 Submitting login form...');
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
        this.page.keyboard.press('Enter')
      ]);

      this.log('info', '✅ Browser initialized and logged in successfully');
      return true;
    } catch (err) {
      this.log('error', `❌ Browser initialization failed: ${err.message}`);
      if (this.browser) {
        await this.browser.close().catch(e => {
          this.log('error', `Error closing browser: ${e.message}`);
        });
        this.browser = null;
        this.page = null;
      }
      return false;
    }
  }

  async solveMathCaptcha() {
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const result = await this.page.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const text = el.textContent.trim();
          if (!text) continue;
          
          let match = text.match(/(\d+)\s*\+\s*(\d+)/);
          if (match) {
            const num1 = parseInt(match[1]);
            const num2 = parseInt(match[2]);
            const answer = num1 + num2;
            console.log(`Found captcha: ${num1} + ${num2} = ${answer}`);
            return answer;
          }
        }
        return null;
      });
      
      return result;
    } catch (err) {
      this.log('error', `Captcha solving error: ${err.message}`);
      return null;
    }
  }

  async markExistingMessagesAsSent() {
    try {
      this.log('info', '🔄 Marking existing messages as sent...');
      const messages = await this.fetchLatestSMS();
      
      messages.forEach(sms => {
        this.sentMessageHashes.add(sms.hash);
      });
      
      this.saveSentMessages();
      this.log('info', `✅ Marked ${messages.length} existing messages as sent`);
    } catch (err) {
      this.log('warn', `⚠️ Error marking messages: ${err.message}`);
    }
  }

  async fetchLatestSMS() {
    try {
      if (!this.page || !this.browser) {
        this.log('warn', '⚠️ Browser or page not initialized');
        return [];
      }

      this.log('debug', '📡 Navigating to SMS reports page...');
      await this.page.goto(CONFIG.sms_reports_url, { 
        waitUntil: 'networkidle2', 
        timeout: 60000 
      });

      let responseData = null;
      const responsePromise = new Promise((resolve) => {
        const handler = async (response) => {
          const url = response.url();
          if (url.includes('data_smscdr.php')) {
            try {
              const data = await response.json();
              this.log('debug', `✅ Received SMS data response with ${data.aaData ? data.aaData.length : 0} records`);
              resolve(data);
              this.page.off('response', handler);
            } catch (err) {
              this.log('error', `Error parsing response JSON: ${err.message}`);
            }
          }
        };
        this.page.on('response', handler);
        
        setTimeout(() => {
          this.page.off('response', handler);
          this.log('warn', '⚠️ SMS data fetch timeout (15s) - no response received');
          resolve(null);
        }, 15000);
      });

      await new Promise(resolve => setTimeout(resolve, 2000));
      
      this.log('debug', '🔄 Reloading datatable...');
      await this.page.evaluate(() => {
        if (typeof jQuery !== 'undefined' && jQuery.fn.dataTable) {
          try {
            const table = jQuery('table').DataTable();
            if (table) {
              table.ajax.reload();
            }
          } catch (e) {
            console.error('DataTable reload error:', e.message);
          }
        }
      });

      responseData = await responsePromise;

      if (responseData && responseData.aaData) {
        this.lastSuccessfulPoll = Date.now();
        
        const messages = responseData.aaData
          .filter((row) => {
            const hasMessage = row[5] && row[5].trim().length > 0;
            const hasSource = row[3] && row[3].trim().length > 0;
            const hasDestination = row[2] && row[2].trim().length > 0;
            return hasMessage && (hasSource || hasDestination);
          })
          .map((row) => {
            const msgData = `${row[0]}_${row[2]}_${row[3]}_${row[5]}`;
            const hash = crypto.createHash('md5').update(msgData).digest('hex');
            
            return {
              hash,
              date: row[0] || '',
              destination_addr: row[2] || '',
              source_addr: row[3] || '',
              client: row[4] || '',
              short_message: row[5] || ''
            };
          });
        
        this.log('debug', `📬 Fetched and processed ${messages.length} SMS messages`);
        return messages;
      }
      
      this.log('warn', '⚠️ No SMS data received in response');
      return [];
    } catch (err) {
      this.log('error', `❌ SMS fetch error: ${err.message}`);
      return [];
    }
  }

  maskPhoneNumber(phoneNumber) {
    if (!phoneNumber || phoneNumber.length < 4) {
      return phoneNumber;
    }
    
    const length = phoneNumber.length;
    const visibleStart = Math.ceil(length / 3);
    const visibleEnd = Math.ceil(length / 3);
    
    const start = phoneNumber.substring(0, visibleStart);
    const end = phoneNumber.substring(length - visibleEnd);
    
    return `${start}****${end}`;
  }

  extractOTP(message) {
    if (!message) return null;
    
    const patterns = [
      /\d{3}-\d{3}/g,
      /code[:\s]+(\d{3,8})/gi,
      /otp[:\s]+(\d{3,8})/gi,
      /verification[:\s]+(\d{3,8})/gi,
      /\b(\d{4,8})\b/g,
    ];
    
    for (const pattern of patterns) {
      const matches = message.match(pattern);
      if (matches && matches.length > 0) {
        let otp = matches[0];
        otp = otp.replace(/code[:\s]+/gi, '').replace(/otp[:\s]+/gi, '').replace(/verification[:\s]+/gi, '');
        return otp.trim();
      }
    }
    
    return null;
  }

  async sendOTPToTelegram(sms) {
    try {
      const source = sms.source_addr || 'Unknown';
      const destination = sms.destination_addr || 'Unknown';
      const message = (sms.short_message || 'No content').replace(/\u0000/g, '');
      
      const maskedDestination = this.maskPhoneNumber(destination);
      const extractedOTP = this.extractOTP(message);
      const otpLine = extractedOTP ? `🔑 *OTP:* \`${extractedOTP}\`\n\n` : '';

      const formatted = `
🔔 *NEW OTP RECEIVED*
━━━━━━━━━━━━━━━━━━━━
📤 *Source:* \`${source}\`

📱 *Destination:* \`${maskedDestination}\`

${otpLine}💬 *Message:*
\`\`\`
${message}
\`\`\`
━━━━━━━━━━━━━━━━━━━━
⏰ _${new Date().toLocaleString()}_
`;

      for (const chatId of CONFIG.telegram_chat_ids) {
        try {
          await this.telegramBot.sendMessage(chatId, formatted, { parse_mode: 'Markdown' });
          this.log('debug', `✅ OTP sent to channel ${chatId}`);
        } catch (err) {
          this.log('error', `❌ Failed to send OTP to ${chatId}: ${err.message}`);
        }
      }
      
      this.otpsSentCount++;
    } catch (err) {
      this.log('error', `❌ Telegram send error: ${err.message}`);
    }
  }

  async pollSMS() {
    if (this.isPolling) {
      this.log('debug', '⏭️ Poll already in progress, skipping...');
      return;
    }
    
    this.isPolling = true;
    this.pollCount++;

    try {
      this.log('debug', `📊 Starting poll #${this.pollCount}...`);
      const messages = await this.fetchLatestSMS();
      
      if (messages.length) {
        let newCount = 0;
        for (const sms of messages) {
          if (!this.sentMessageHashes.has(sms.hash)) {
            this.log('info', `🆕 New SMS detected from ${sms.source_addr} to ${sms.destination_addr}`);
            await this.sendOTPToTelegram(sms);
            this.sentMessageHashes.add(sms.hash);
            newCount++;
            
            if (this.sentMessageHashes.size > 1000) {
              const hashArray = Array.from(this.sentMessageHashes);
              this.sentMessageHashes = new Set(hashArray.slice(-500));
            }
          }
        }
        
        if (newCount > 0) {
          this.log('info', `✅ Sent ${newCount} new OTP(s) to Telegram`);
          this.saveSentMessages();
        }
      } else {
        this.log('debug', '✓ No new SMS messages');
      }
    } catch (err) {
      this.log('error', `❌ Poll error: ${err.message}`);
    } finally {
      this.isPolling = false;
    }
  }

  startPolling() {
    this.log('info', '⏱️ Starting SMS polling...');
    
    // Initial poll
    this.pollSMS();
    
    // Set up interval
    this.pollInterval = setInterval(() => {
      this.pollSMS();
    }, CONFIG.poll_interval);

    this.log('info', `✅ Polling started (every ${CONFIG.poll_interval / 1000}s)`);

    // Health check every 60s
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60000);
  }

  performHealthCheck() {
    const timeSinceLastPoll = Date.now() - this.lastSuccessfulPoll;
    const minutesAgo = Math.floor(timeSinceLastPoll / 60000);
    
    this.log('debug', `🏥 Health check: Last poll ${minutesAgo}m ago`);
    
    if (timeSinceLastPoll > 300000 && this.browser) {
      this.log('warn', '⚠️ No successful poll in 5 minutes - reconnecting browser...');
      
      if (this.browser) {
        this.browser.close().catch(err => {
          this.log('error', `Error closing browser: ${err.message}`);
        });
      }
      this.browser = null;
      this.page = null;
      this.initializeBrowser();
    }
  }

  async sendConnectionMessage() {
    const message = `✅ *OTP Bot Connected*
━━━━━━━━━━━━━━━━━━━━
🤖 Bot is now active and monitoring for OTPs.

📊 *Status:* Active
🔄 *Poll Interval:* ${CONFIG.poll_interval / 1000}s
📌 *Channels:* ${CONFIG.telegram_chat_ids.length}

The bot will forward all incoming OTPs to the connected Telegram channels.
━━━━━━━━━━━━━━━━━━━━
⏰ Started: ${new Date().toLocaleString()}`;
    
    for (const chatId of CONFIG.telegram_chat_ids) {
      try {
        await this.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        this.log('info', `📨 Connection message sent to ${chatId}`);
      } catch (err) {
        this.log('error', `❌ Failed to send connection message to ${chatId}: ${err.message}`);
      }
    }
  }

  setupTelegramHandlers() {
    this.telegramBot.onText(/\/start/, (msg) => {
      this.log('debug', `📱 /start command from ${msg.chat.id}`);
      this.telegramBot.sendMessage(
        msg.chat.id,
        `🤖 OTP Bot is active and monitoring!\nUse /status to check connection status.`
      );
    });

    this.telegramBot.onText(/\/status/, (msg) => {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const timeSinceLastPoll = Date.now() - this.lastSuccessfulPoll;
      const minutesSinceLastPoll = Math.floor(timeSinceLastPoll / 60000);
      
      const statusMessage = `📊 *OTP Bot Status*
━━━━━━━━━━━━━━━━━━━━

✅ *Status:* ${this.browser ? 'Running' : 'Reconnecting...'}

📨 *OTPs Sent:* ${this.otpsSentCount}

⏱️ *Poll Interval:* ${CONFIG.poll_interval / 1000}s

🌐 *Browser:* ${this.browser ? 'Active ✅' : 'Inactive ❌'}

📡 *Active Channels:* ${CONFIG.telegram_chat_ids.length}

📊 *Total Polls:* ${this.pollCount}

🕐 *Last Poll:* ${minutesSinceLastPoll}m ago

⏰ *Uptime:* ${hours}h ${minutes}m

━━━━━━━━━━━━━━━━━━━━`;
      
      this.telegramBot.sendMessage(msg.chat.id, statusMessage, { parse_mode: 'Markdown' });
      this.log('debug', `📊 Status requested by ${msg.chat.id}`);
    });

    this.telegramBot.on('polling_error', (error) => {
      this.log('error', `❌ Telegram polling error: ${error.message}`);
    });

    this.log('info', '✅ Telegram handlers configured');
  }

  async start() {
    try {
      if (this.isRunning) {
        this.log('warn', '⚠️ Bot is already running');
        return;
      }

      this.log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log('info', '🚀 OTP Bot Starting...');
      this.log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Initialize Telegram bot
      this.log('info', '🤖 Initializing Telegram bot...');
      this.telegramBot = new TelegramBot(CONFIG.telegram_bot_token, { polling: true });
      this.setupTelegramHandlers();
      this.log('info', '✅ Telegram bot connected');

      // Initialize browser
      this.log('info', '🌐 Initializing browser automation...');
      const browserInitialized = await this.initializeBrowser();
      if (!browserInitialized) {
        throw new Error('Failed to initialize browser');
      }

      // Mark existing messages as sent
      await this.markExistingMessagesAsSent();

      // Start polling
      this.startPolling();

      // Send connection message
      await this.sendConnectionMessage();

      this.isRunning = true;

      this.log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log('info', '✅ OTP Bot Started Successfully!');
      this.log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      this.log('info', `📱 Telegram Token: ${CONFIG.telegram_bot_token.substring(0, 15)}...`);
      this.log('info', `👤 Panel User: ${CONFIG.panel_username}`);
      this.log('info', `📡 Monitoring Channels: ${CONFIG.telegram_chat_ids.join(', ')}`);
      this.log('info', `⏱️ Poll Interval: ${CONFIG.poll_interval / 1000} seconds`);
      this.log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    } catch (err) {
      this.log('error', `❌ Failed to start bot: ${err.message}`);
      await this.stop();
      process.exit(1);
    }
  }

  async stop() {
    try {
      this.log('info', '🛑 Stopping bot...');

      if (this.pollInterval) {
        clearInterval(this.pollInterval);
      }
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
      }

      if (this.telegramBot) {
        this.telegramBot.stopPolling();
      }

      if (this.browser) {
        await this.browser.close();
      }

      this.saveSentMessages();
      this.isRunning = false;

      this.log('info', '✅ Bot stopped');
    } catch (err) {
      this.log('error', `Error stopping bot: ${err.message}`);
    }
  }
}

// ==================== MAIN EXECUTION ====================
const bot = new OTPBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n');
  bot.log('info', '📴 Received SIGINT - shutting down gracefully...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n');
  bot.log('info', '📴 Received SIGTERM - shutting down gracefully...');
  await bot.stop();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.log('\n');
  bot.log('error', `💥 Uncaught Exception: ${err.message}`);
  bot.log('error', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  bot.log('error', `💥 Unhandled Rejection at ${promise}: ${reason}`);
});

// Start the bot
bot.start().catch(err => {
  bot.log('error', `Fatal error: ${err.message}`);
  process.exit(1);
});
