import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareExtensionCopy } from './lib/extensionCopy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist');
const CHROMIUM = process.env.CHROMIUM_PATH || '/Applications/Chromium.app/Contents/MacOS/Chromium';
const EVIDENCE_DIR = '/Users/pritdhanani/.no-mistakes/evidence/01M4EHSMR4A4F5Z9B1GJ61KCED';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const evidenceDir = process.env.EVIDENCE_DIR || EVIDENCE_DIR;
  fs.mkdirSync(evidenceDir, { recursive: true });

  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
    console.log('Building dist/ before test...');
    const { execSync } = await import('node:child_process');
    execSync('npm run build', { cwd: REPO, stdio: 'inherit' });
  }

  const extCopy = prepareExtensionCopy({ distDir: DIST, driverHtml: path.join(HERE, 'driver.html') });
  const profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scoutfox-e2e-prof-')));

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM,
      headless: true,
      pipe: true,
      enableExtensions: true,
      defaultViewport: null,
      args: [
        `--disable-extensions-except=${extCopy.dir}`,
        `--load-extension=${extCopy.dir}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,950'
      ]
    });

    console.log('Chromium launched. Waiting for service worker...');
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().endsWith('/background/sw.js'),
      { timeout: 20000 }
    );
    const extensionId = new URL(swTarget.url()).host;
    console.log(`Service worker active. Extension ID: ${extensionId}`);

    const page = await browser.newPage();
    await page.setViewport({ width: 440, height: 950 });
    const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel/sidepanel.html`;
    console.log(`Navigating to sidepanel: ${sidepanelUrl}`);
    await page.goto(sidepanelUrl, { waitUntil: 'load' });
    await sleep(500);

    // Switch to Settings tab
    console.log('Switching to Settings tab...');
    await page.click('button[data-tab="settings"]');
    await sleep(300);

    // Verify default state
    const initialProvider = await page.$eval('#providerSelect', (el) => el.value);
    console.log(`Initial provider: ${initialProvider}`);

    // Switch to NVIDIA NIM
    console.log('Selecting NVIDIA NIM provider in UI...');
    await page.select('#providerSelect', 'nvidia');
    await page.evaluate(() => {
      document.getElementById('providerSelect').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(500);

    // Check placeholder, timeout, and API key placeholder
    const nvidiaDetails = await page.evaluate(() => {
      return {
        provider: document.getElementById('providerSelect').value,
        baseUrlPlaceholder: document.getElementById('baseUrlInput').placeholder,
        timeoutValue: document.getElementById('llmTimeoutInput').value,
        apiKeyPlaceholder: document.getElementById('apiKeyInput').placeholder
      };
    });
    console.log('NVIDIA form details:', nvidiaDetails);

    if (nvidiaDetails.provider !== 'nvidia') throw new Error('Provider select is not nvidia');
    if (!nvidiaDetails.baseUrlPlaceholder.includes('integrate.api.nvidia.com')) {
      throw new Error(`Unexpected baseUrl placeholder: ${nvidiaDetails.baseUrlPlaceholder}`);
    }
    if (nvidiaDetails.timeoutValue !== '300000') {
      throw new Error(`NVIDIA default timeout must be 300000, got ${nvidiaDetails.timeoutValue}`);
    }

    // Capture Settings Overview Screenshot
    const shot1Path = path.join(evidenceDir, 'sidepanel-nvidia-settings-overview.png');
    await page.screenshot({ path: shot1Path, fullPage: true });
    console.log(`Screenshot saved: ${shot1Path}`);

    // Wait for live models to fetch (either triggered by provider change or explicit fetch button)
    console.log('Fetching live models from NVIDIA NIM...');
    await page.click('#btnFetchModels');
    
    // Wait for fetch status to show retrieved models
    await page.waitForFunction(() => {
      const status = document.getElementById('modelFetchStatus')?.textContent || '';
      return status.includes('Retrieved') || status.includes('Loaded');
    }, { timeout: 15000 });

    const fetchStatusText = await page.$eval('#modelFetchStatus', (el) => el.textContent);
    console.log(`Model fetch status: ${fetchStatusText}`);

    // Open dynamic combobox dropdown
    console.log('Opening dynamic searchable combobox...');
    await page.click('#modelComboboxTrigger');
    await sleep(400);

    // Type 'nemotron' into the search input
    console.log('Filtering models with query "nemotron"...');
    await page.type('#modelSearchInside', 'nemotron');
    await sleep(400);

    // Capture Combobox with filtered models Screenshot
    const shot2Path = path.join(evidenceDir, 'sidepanel-nvidia-combobox-models.png');
    await page.screenshot({ path: shot2Path, fullPage: true });
    console.log(`Screenshot saved: ${shot2Path}`);

    // Select 'nvidia/llama-3.1-nemotron-70b-instruct'
    const targetModel = 'nvidia/llama-3.1-nemotron-70b-instruct';
    console.log(`Selecting model: ${targetModel}`);
    const foundOption = await page.evaluate((target) => {
      const items = Array.from(document.querySelectorAll('.combobox-option-item'));
      const targetItem = items.find((i) => i.textContent.includes(target));
      if (targetItem) {
        targetItem.click();
        return true;
      }
      return false;
    }, targetModel);

    if (!foundOption) {
      throw new Error(`Model ${targetModel} not found in combobox items`);
    }
    await sleep(400);

    // Verify model label and current model badge updated
    const selectedState = await page.evaluate(() => {
      return {
        selectedLabel: document.getElementById('modelSelectedLabel')?.textContent,
        headerBadge: document.getElementById('currentModelBadge')?.textContent
      };
    });
    console.log('Selected model state:', selectedState);

    // Capture Selected Badge Screenshot
    const shot3Path = path.join(evidenceDir, 'sidepanel-nvidia-selected-badge.png');
    await page.screenshot({ path: shot3Path, fullPage: true });
    console.log(`Screenshot saved: ${shot3Path}`);

    // Test custom timeout and provider switching preservation (review fixes verification)
    console.log('Testing custom timeout preservation across provider switches...');
    await page.evaluate(() => {
      const input = document.getElementById('llmTimeoutInput');
      input.value = '420000';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('#btnSaveSettings');
    await sleep(500);

    // Switch to OpenAI
    await page.select('#providerSelect', 'openai');
    await page.evaluate(() => {
      document.getElementById('providerSelect').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(500);
    const openaiTimeout = await page.$eval('#llmTimeoutInput', (el) => el.value);
    console.log(`Timeout after switching to OpenAI: ${openaiTimeout}ms`);

    // Switch back to NVIDIA: custom 420000ms should be restored!
    await page.select('#providerSelect', 'nvidia');
    await page.evaluate(() => {
      document.getElementById('providerSelect').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(500);
    const restoredNvidiaTimeout = await page.$eval('#llmTimeoutInput', (el) => el.value);
    console.log(`Timeout after switching back to NVIDIA: ${restoredNvidiaTimeout}ms`);
    if (restoredNvidiaTimeout !== '420000') {
      throw new Error(`Expected restored timeout 420000, got ${restoredNvidiaTimeout}`);
    }

    // Inspect persisted storage
    const storedSettings = await page.evaluate(() => {
      return new Promise((resolve) => chrome.storage.local.get('agent_settings', (res) => resolve(res.agent_settings)));
    });

    const resultSummary = {
      timestamp: new Date().toISOString(),
      extensionId,
      provider: storedSettings.provider,
      model: storedSettings.model,
      fetchStatusText,
      nvidiaConfig: storedSettings.providerConfigs?.nvidia,
      globalTimeoutMs: storedSettings.llmTimeoutMs,
      screenshots: [shot1Path, shot2Path, shot3Path]
    };

    const summaryPath = path.join(evidenceDir, 'sidepanel-nvidia-verification.json');
    fs.writeFileSync(summaryPath, JSON.stringify(resultSummary, null, 2));
    console.log(`Summary written to ${summaryPath}`);

    console.log('✅ NVIDIA NIM UI End-to-End verification completed successfully!');
  } finally {
    if (browser) await browser.close();
    extCopy.remove();
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
