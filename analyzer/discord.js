/**
 * discord.js
 * Handles Discord delivery:
 *  - Immediate pings for critical bugs (doesn't wait for full report)
 *  - Full report delivery at end of run
 */

const https = require('https');
const fs    = require('fs');

const SEVERITY_COLORS = {
  CRITICAL: 0xe74c3c,
  HIGH:     0xe67e22,
  MEDIUM:   0xf1c40f,
  LOW:      0x3498db,
  info:     0x95a5a6,
};

/**
 * Send an immediate ping for a critical bug (called as soon as bug is detected).
 */
async function pingCriticalBug(bug, cfg) {
  const { webhookUrl, pingUserId } = cfg.discord;
  if (!webhookUrl) return;

  const mention = pingUserId ? `<@${pingUserId}> ` : '';
  const severity = (bug.diagnosis?.severity || bug.severity || 'UNKNOWN').toUpperCase();
  const color    = SEVERITY_COLORS[severity] || SEVERITY_COLORS.MEDIUM;

  const embed = {
    title: `🐛 ${severity} BUG — ${bug.type || 'JS Error'}`,
    description: truncate(bug.message || 'No message', 300),
    color,
    fields: [
      { name: '📍 Matchup', value: bug.matchup || (bug.matchups?.join(', ')) || 'unknown', inline: true },
      { name: '🔁 Occurrences', value: String(bug.occurrences || 1), inline: true },
      { name: '🔎 Likely Cause', value: truncate(bug.diagnosis?.likelyCause || 'Analyzing…', 300) },
      { name: '🔧 Suggested Fix', value: truncate(bug.diagnosis?.suggestedFix || 'See full report', 300) },
      { name: '📋 Repro Steps', value: truncate(bug.diagnosis?.reproSteps || 'See full report', 400) },
    ],
    footer: { text: 'Beyond RTS QA System · Full report coming at end of run' },
    timestamp: new Date().toISOString(),
  };

  // Add stack trace if available
  if (bug.stack) {
    embed.fields.push({ name: '📚 Stack', value: `\`\`\`${truncate(bug.stack, 500)}\`\`\`` });
  }

  // Add paste-to-Claude prompt if available
  if (bug.diagnosis?.pasteToClaudePrompt) {
    embed.fields.push({
      name: '📤 Paste to Claude →',
      value: `\`\`\`${truncate(bug.diagnosis.pasteToClaudePrompt, 800)}\`\`\``,
    });
  }

  const payload = {
    content: `${mention}🚨 **Critical bug detected during playtesting!**`,
    embeds: [embed],
  };

  try {
    await post(webhookUrl, JSON.stringify(payload), 'application/json');
    console.log(`  📬 Discord ping sent for: ${bug.type}`);
  } catch (err) {
    console.log(`  ⚠️  Discord ping failed: ${err.message}`);
  }
}

/**
 * Send the full QA report summary + HTML attachment.
 */
async function sendFullReport(summary, htmlPath, bugCount, cfg) {
  const { webhookUrl, pingUserId } = cfg.discord;
  if (!webhookUrl) return;

  const mention = pingUserId ? `<@${pingUserId}> ` : '';
  const hasBugs = bugCount > 0;

  const embed = {
    title: '✅ Beyond RTS — Full QA Report Ready',
    description: truncate(summary, 3800),
    color: hasBugs ? 0xe67e22 : 0x27ae60,
    footer: { text: 'Full HTML report attached — open in browser for screenshots + matrix + all bug prompts' },
    timestamp: new Date().toISOString(),
  };

  const payload = {
    content: `${mention}QA run complete! ${hasBugs ? `⚠️ ${bugCount} bug(s) found.` : '✅ No bugs detected.'}`,
    embeds: [embed],
  };

  try {
    await post(webhookUrl, JSON.stringify(payload), 'application/json');
  } catch (err) {
    console.log(`  ⚠️  Discord summary failed: ${err.message}`);
  }

  // Attach HTML report
  if (htmlPath && fs.existsSync(htmlPath)) {
    const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
    const fileData = fs.readFileSync(htmlPath);
    const form = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa-report.html"\r\nContent-Type: text/html\r\n\r\n`),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    try {
      await post(webhookUrl, form, `multipart/form-data; boundary=${boundary}`);
      console.log('  📬 Full report sent to Discord!');
    } catch (err) {
      console.log(`  ⚠️  Discord file upload failed: ${err.message}`);
    }
  }
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 3) + '…' : str;
}

function post(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': buf.length },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0,200)}`)));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

module.exports = { pingCriticalBug, sendFullReport };
