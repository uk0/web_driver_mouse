/**
 * Razer Mouse WebHID Protocol Driver
 *
 * Handles communication with Razer mice over WebHID using the 90-byte
 * Razer HID feature report protocol. Automatically resolves the correct
 * vendor-specific control interface when a device exposes multiple HID
 * collections (mouse input, keyboard-like, vendor-specific).
 *
 * Supported commands: DPI, Polling Rate, Battery, Mouse Rotation.
 */

const RAZER_VENDOR_ID = 0x1532;

const REPORT_LEN = 90;
const REPORT_ID = 0x00;

/* Status byte values (offset 0) */
const STATUS_NEW     = 0x00;
const STATUS_BUSY    = 0x01;
const STATUS_SUCCESS = 0x02;
const STATUS_FAILURE = 0x03;

/* Polling-rate Hz -> bitmask lookup */
const POLLING_RATE_MAP = {
  125:  0x01,
  250:  0x02,
  500:  0x04,
  1000: 0x08,
  2000: 0x10,
  4000: 0x20,
  8000: 0x40,
};

/* Battery queries use a fixed transaction ID on many newer models */
const BATTERY_TRANSACTION_ID = 0x1f;

/* Minimum delay (ms) between consecutive commands so the MCU can keep up */
const CMD_INTERVAL_MS = 80;

/**
 * Compute the Razer CRC: XOR of bytes 2 through 87 inclusive.
 * @param {Uint8Array} buf  Full 90-byte report buffer.
 * @returns {number}
 */
function crc(buf) {
  let v = 0;
  for (let i = 2; i < 88; i++) v ^= buf[i];
  return v;
}

/**
 * Return true when at least one HID collection on the device uses a
 * vendor-defined usage page (>= 0xFF00).  That collection carries the
 * feature-report control interface Razer mice expose for configuration.
 * @param {HIDDevice} dev
 * @returns {boolean}
 */
function isControlInterface(dev) {
  return dev.collections.some(c => c.usagePage >= 0xFF00);
}

/**
 * Given an array of HIDDevice objects that all share the same productId
 * (i.e. they represent the same physical mouse), return the single device
 * whose collections include the vendor-specific control interface.
 *
 * Falls back to the first device if none match (should not happen in
 * practice, but avoids a hard crash).
 *
 * @param {HIDDevice[]} group
 * @returns {HIDDevice}
 */
function pickControlDevice(group) {
  return group.find(isControlInterface) || group[0];
}

export class RazerProtocol {

  /** @private */ _device = null;
  /** @private */ _deviceInfo = null;
  /** @private */ _txId = 0;
  /** @private */ _inputCallback = null;
  /** @private */ _boundInputHandler = null;

  constructor() {
    this._device = null;
    this._deviceInfo = null;
    this._txId = 0;
    this._inputCallback = null;
    this._boundInputHandler = null;
  }

  /* -----------------------------------------------------------
   *  Connection lifecycle
   * --------------------------------------------------------- */

  /**
   * Prompt the user for a Razer mouse, then automatically resolve the
   * control interface so only one usable device is surfaced.
   *
   * @returns {Promise<{device: HIDDevice, deviceInfo: object}>}
   */
  async connect() {
    if (!navigator.hid) {
      throw new Error('WebHID is not supported in this browser. Use Chrome or Edge.');
    }

    // Step 1 -- trigger the browser permission dialog.
    // The user sees one picker per *physical* mouse, but the browser may
    // grant access to every HID interface on that device.
    await navigator.hid.requestDevice({
      filters: [{ vendorId: RAZER_VENDOR_ID }],
    });

    // Step 2 -- retrieve ALL permitted Razer HID interfaces.
    const allDevices = await navigator.hid.getDevices();
    const razerDevices = allDevices.filter(d => d.vendorId === RAZER_VENDOR_ID);

    if (razerDevices.length === 0) {
      throw new Error('No Razer device was selected or permitted.');
    }

    // Step 3 -- group by productId (one physical mouse = one productId).
    /** @type {Map<number, HIDDevice[]>} */
    const groups = new Map();
    for (const d of razerDevices) {
      const pid = d.productId;
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(d);
    }

    // Step 4 -- for each physical mouse, pick the vendor-specific control
    // interface and discard the rest.  If multiple physical mice are
    // connected we take the first group (future: let caller choose).
    const firstGroup = groups.values().next().value;
    const controlDevice = pickControlDevice(firstGroup);

    // Step 5 -- open the control interface if necessary.
    if (!controlDevice.opened) {
      await controlDevice.open();
    }

    this._device = controlDevice;
    this._deviceInfo = {
      name:         controlDevice.productName || 'Razer Mouse',
      vendorId:     controlDevice.vendorId,
      productId:    controlDevice.productId,
      serialNumber: controlDevice.serialNumber || '',
    };

    // Wire up input-report forwarding.
    this._boundInputHandler = this._handleInputReport.bind(this);
    this._device.addEventListener('inputreport', this._boundInputHandler);

    return {
      device:     this._device,
      deviceInfo: { ...this._deviceInfo },
    };
  }

  /**
   * Close the HID device and release resources.
   */
  async disconnect() {
    if (this._device) {
      if (this._boundInputHandler) {
        this._device.removeEventListener('inputreport', this._boundInputHandler);
        this._boundInputHandler = null;
      }
      if (this._device.opened) {
        await this._device.close();
      }
      this._device = null;
      this._deviceInfo = null;
    }
  }

  /**
   * @returns {boolean}
   */
  isConnected() {
    return this._device !== null && this._device.opened === true;
  }

  /**
   * @returns {object|null}
   */
  getDeviceInfo() {
    return this._deviceInfo ? { ...this._deviceInfo } : null;
  }

  /* -----------------------------------------------------------
   *  Input-report passthrough
   * --------------------------------------------------------- */

  /**
   * Register a callback that fires on every HID input report.
   * @param {function} callback  Receives `{ reportId, data }`.
   */
  onInputReport(callback) {
    this._inputCallback = typeof callback === 'function' ? callback : null;
  }

  /** @private */
  _handleInputReport(event) {
    if (this._inputCallback) {
      this._inputCallback({
        reportId: event.reportId,
        data:     new Uint8Array(event.data.buffer),
      });
    }
  }

  /* -----------------------------------------------------------
   *  Low-level protocol helpers
   * --------------------------------------------------------- */

  /**
   * Build a 90-byte Razer command buffer.
   *
   * @param {number}   cmdClass   Command class byte.
   * @param {number}   cmdId      Command ID byte.
   * @param {number}   dataSize   Number of argument bytes.
   * @param {number[]} [args=[]]  Argument bytes (max 80).
   * @param {number|null} [txOverride=null]  Force a specific transaction ID.
   * @returns {Uint8Array}
   */
  _buildCommand(cmdClass, cmdId, dataSize, args = [], txOverride = null) {
    const buf = new Uint8Array(REPORT_LEN);

    buf[0] = STATUS_NEW;
    buf[1] = txOverride !== null ? (txOverride & 0xFF) : (this._txId++ & 0xFF);
    // bytes 2-4 stay 0x00 (remaining packets, protocol type, reserved)
    buf[5] = dataSize;
    buf[6] = cmdClass;
    buf[7] = cmdId;

    for (let i = 0; i < args.length && i < 80; i++) {
      buf[8 + i] = args[i];
    }

    buf[88] = crc(buf);
    buf[89] = 0x00;

    return buf;
  }

  /**
   * Send a command buffer to the device.  Prefers `sendFeatureReport`;
   * falls back to `sendReport` if the first call fails.
   *
   * @param {Uint8Array} buf
   * @returns {Promise<boolean>}
   */
  async _send(buf) {
    if (!this.isConnected()) {
      throw new Error('Device is not connected.');
    }

    try {
      await this._device.sendFeatureReport(REPORT_ID, buf);
      return true;
    } catch (_) {
      // Fallback for devices that only accept output reports.
      try {
        await this._device.sendReport(REPORT_ID, buf);
        return true;
      } catch (e) {
        throw new Error(`Failed to send command: ${e.message}`);
      }
    }
  }

  /**
   * Send a command and read back the feature-report response.
   *
   * @param {Uint8Array} buf  The outgoing 90-byte command.
   * @returns {Promise<Uint8Array>}  The 90-byte response, or null on failure.
   */
  async _sendAndReceive(buf) {
    await this._send(buf);
    await _sleep(CMD_INTERVAL_MS);

    try {
      const view = await this._device.receiveFeatureReport(REPORT_ID);
      return new Uint8Array(view.buffer);
    } catch (_) {
      return null;
    }
  }

  /* -----------------------------------------------------------
   *  DPI
   * --------------------------------------------------------- */

  /**
   * Set X and Y DPI.
   *
   * Protocol:
   *   Class 0x04, ID 0x06, Size 0x0A
   *   Args: [stage, enableX, enableY, 0x00, X_HI, X_LO, Y_HI, Y_LO, 0x00, 0x00]
   *
   * Followed by a save/confirm:
   *   Class 0x04, ID 0x86, Size 0x01, Args: [0x01]
   *
   * @param {number} x  X-axis DPI (100-30000).
   * @param {number} y  Y-axis DPI (100-30000).
   * @returns {Promise<boolean>}
   */
  async setDPI(x, y) {
    x = Math.max(100, Math.min(30000, Math.round(x)));
    y = Math.max(100, Math.min(30000, Math.round(y)));

    const args = [
      0x01,               // DPI stage 1
      0x01,               // X enabled
      0x01,               // Y enabled
      0x00,               // reserved
      (x >> 8) & 0xFF,    // X high
      x & 0xFF,           // X low
      (y >> 8) & 0xFF,    // Y high
      y & 0xFF,           // Y low
      0x00,               // reserved
      0x00,               // reserved
    ];

    const cmd = this._buildCommand(0x04, 0x06, 0x0A, args);
    const ok = await this._send(cmd);
    if (!ok) return false;

    // Save / persist the DPI value.
    await _sleep(CMD_INTERVAL_MS);
    const saveCmd = this._buildCommand(0x04, 0x86, 0x01, [0x01]);
    return this._send(saveCmd);
  }

  /* -----------------------------------------------------------
   *  Polling rate
   * --------------------------------------------------------- */

  /**
   * Set the USB polling rate.
   *
   * Protocol:
   *   Class 0x00, ID 0x40, Size 0x02
   *   Args: [0x01, rateMask]
   *
   * @param {number} rateHz  One of 125, 250, 500, 1000, 2000, 4000, 8000.
   * @returns {Promise<boolean>}
   */
  async setPollingRate(rateHz) {
    const mask = POLLING_RATE_MAP[rateHz];
    if (mask === undefined) {
      throw new Error(
        `Unsupported polling rate ${rateHz} Hz. ` +
        `Accepted values: ${Object.keys(POLLING_RATE_MAP).join(', ')}`
      );
    }

    const cmd = this._buildCommand(0x00, 0x40, 0x02, [0x01, mask]);
    return this._send(cmd);
  }

  /* -----------------------------------------------------------
   *  Battery
   * --------------------------------------------------------- */

  /**
   * Query battery level and charging state.
   *
   * Battery level:  Class 0x07, ID 0x80, Size 0x02, TX 0x1f
   * Charging state: Class 0x07, ID 0x84, Size 0x02, TX 0x1f
   *
   * Response byte at offset 9 holds the raw value.
   *   - Level: 0-255 raw, mapped to 0-100 %.
   *   - Charging: 0x00 = not charging, 0x01 = charging.
   *
   * @returns {Promise<{level: number, charging: boolean}>}
   */
  async getBattery() {
    // --- battery level ---
    const levelCmd = this._buildCommand(
      0x07, 0x80, 0x02, [0x00, 0x00], BATTERY_TRANSACTION_ID,
    );
    const levelResp = await this._sendAndReceive(levelCmd);

    let level = 0;
    if (levelResp && levelResp[2] === 0x00 /* remaining == 0 => valid */) {
      const raw = levelResp[9]; // argument offset 1
      level = Math.round((raw / 255) * 100);
    }

    // --- charging state ---
    await _sleep(CMD_INTERVAL_MS);
    const chargeCmd = this._buildCommand(
      0x07, 0x84, 0x02, [0x00, 0x00], BATTERY_TRANSACTION_ID,
    );
    const chargeResp = await this._sendAndReceive(chargeCmd);

    let charging = false;
    if (chargeResp) {
      charging = chargeResp[9] !== 0x00;
    }

    return { level, charging };
  }

  /* -----------------------------------------------------------
   *  Mouse rotation / angle offset
   * --------------------------------------------------------- */

  /**
   * Set the sensor rotation angle.
   *
   * Protocol:
   *   Class 0x0B, ID 0x14, Size 0x03
   *   Args: [0x01 (enable), 0x01 (persist), angleByte]
   *
   * Negative angles are encoded as 256 + angle (two's complement byte).
   *
   * @param {number} angle  Degrees, -44 to +44.
   * @returns {Promise<boolean>}
   */
  async setRotation(angle) {
    angle = Math.max(-44, Math.min(44, Math.round(angle)));

    // Encode signed byte.
    const angleByte = angle < 0 ? (256 + angle) : angle;

    const cmd = this._buildCommand(0x0B, 0x14, 0x03, [0x01, 0x01, angleByte]);
    return this._send(cmd);
  }
}

/* -----------------------------------------------------------
 *  Internal utility
 * --------------------------------------------------------- */

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
