/**
 * Logitech HID++ 2.0 Protocol Driver
 *
 * Handles communication with Logitech mice over WebHID using the HID++
 * short (0x10) and long (0x11) report protocol. Locates the correct
 * vendor-specific collection that carries output reports, then provides
 * DPI, polling-rate, and battery commands.
 *
 * DPI changes follow a 3-step handshake: Prepare -> Set -> Confirm,
 * each separated by 50 ms to give the firmware time to commit.
 *
 * Polling-rate and battery commands use IRoot feature discovery
 * (feature 0x0000) to resolve the runtime feature index before issuing
 * the actual request.
 *
 * Supported commands: DPI, Polling Rate, Battery.
 */

const LOGITECH_VID = 0x046D;

const HIDPP = { SHORT: 0x10, LONG: 0x11 };

const DEVICE_INDEX = 0x01;

const FEATURE = {
  BATTERY:  0x06,
  CONFIRM:  0x07,
  PREPARE:  0x0A,
  DPI:      0x0B,
};

const SW_ID = 0x0A;

const DPI_PRESETS = [400, 800, 1600, 3200, 6400];

const POLLING_MAP = {
  1000: 0x01,
  500:  0x02,
  250:  0x04,
  125:  0x08,
};

const FEATURE_ID = {
  ROOT:            0x0000,
  FEATURE_SET:     0x0001,
  DEVICE_FW:       0x0003,
  DEVICE_NAME:     0x0005,
  UNIFIED_BATTERY: 0x1004,
  BATTERY_STATUS:  0x1000,
  REPORT_RATE:     0x8060,
};

const BATTERY_STATUS_MAP = {
  0x00: 'Discharging',
  0x01: 'Charging',
  0x02: 'Nearly Full',
  0x03: 'Full',
  0x04: 'Slow Discharge',
};

/* ---------------------------------------------------------------
 *  Internal helpers
 * --------------------------------------------------------------- */

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Return true when a HID collection uses the vendor-defined usage page
 * (0xFF00) and exposes at least one output report, which is the
 * hallmark of the HID++ control endpoint.
 *
 * @param {HIDCollectionInfo} c
 * @returns {boolean}
 */
function _isHidppCollection(c) {
  return c.usagePage === 0xFF00 && Array.isArray(c.outputReports) && c.outputReports.length > 0;
}

/* ---------------------------------------------------------------
 *  Exported class
 * --------------------------------------------------------------- */

export class LogitechHIDPP {

  /** @private */ _device = null;
  /** @private */ _deviceInfo = null;
  /** @private */ _inputCallback = null;
  /** @private */ _boundInputHandler = null;
  /** @private */ _batteryFeatureIndex = null;
  /** @private */ _reportRateFeatureIndex = null;
  /** @private */ _deviceNameFeatureIndex = null;

  constructor() {
    this._device = null;
    this._deviceInfo = null;
    this._inputCallback = null;
    this._boundInputHandler = null;
    this._batteryFeatureIndex = null;
    this._reportRateFeatureIndex = null;
    this._deviceNameFeatureIndex = null;
  }

  /* -----------------------------------------------------------
   *  Connection lifecycle
   * --------------------------------------------------------- */

  /**
   * Prompt the user for a Logitech HID device, locate the HID++
   * control collection, and open the device.
   *
   * @returns {Promise<{device: HIDDevice, deviceInfo: object}>}
   */
  /** Manual connect — opens browser picker then connects. */
  async connect() {
    if (!navigator.hid) throw new Error('WebHID not supported');
    await navigator.hid.requestDevice({ filters: [{ vendorId: LOGITECH_VID }] });
    return this._connectFromGranted();
  }

  /** Auto-reconnect — uses previously granted permissions, no picker. */
  async reconnect() {
    if (!navigator.hid) throw new Error('WebHID not supported');
    return this._connectFromGranted();
  }

  /** Shared connect logic. */
  async _connectFromGranted() {
    const allDevices = await navigator.hid.getDevices();
    const logitechDevices = allDevices.filter(d => d.vendorId === LOGITECH_VID);

    if (logitechDevices.length === 0) {
      throw new Error('No Logitech device was selected or permitted.');
    }

    // Step 3 -- find the device whose collections include the HID++
    // vendor-specific endpoint (usagePage 0xFF00 with output reports).
    const target = logitechDevices.find(d =>
      d.collections.some(_isHidppCollection),
    );

    if (!target) {
      throw new Error(
        'No Logitech HID++ control interface found. ' +
        'Make sure the device supports HID++ 2.0.',
      );
    }

    // Step 4 -- open.
    if (!target.opened) {
      await target.open();
    }

    this._device = target;

    // Reset cached feature indices for the new connection.
    this._batteryFeatureIndex = null;
    this._reportRateFeatureIndex = null;
    this._deviceNameFeatureIndex = null;

    // Wire up input-report forwarding.
    this._boundInputHandler = this._handleInputReport.bind(this);
    this._device.addEventListener('inputreport', this._boundInputHandler);

    // Query the real mouse name (not "USB Receiver") and serial number
    // via HID++ 2.0 protocol.
    const realName = await this._queryDeviceName();
    const serialNumber = await this._querySerialNumber();

    this._deviceInfo = {
      name:         realName || target.productName || 'Logitech Mouse',
      vendorId:     target.vendorId,
      productId:    target.productId,
      serialNumber: serialNumber || target.serialNumber || '',
    };

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
      this._batteryFeatureIndex = null;
      this._reportRateFeatureIndex = null;
      this._deviceNameFeatureIndex = null;
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
   *  Low-level transport
   * --------------------------------------------------------- */

  /**
   * Send a HID++ report to the device.
   *
   * @param {number}   reportId   HIDPP.SHORT (0x10) or HIDPP.LONG (0x11).
   * @param {number[]} payload    Payload bytes (without the report-id prefix).
   * @returns {Promise<void>}
   */
  async _sendReport(reportId, payload) {
    if (!this.isConnected()) {
      throw new Error('Device is not connected.');
    }
    const data = new Uint8Array(payload);
    await this._device.sendReport(reportId, data);
  }

  /**
   * Wait for an input report that satisfies a predicate.
   *
   * Installs a temporary listener on the device and resolves with the
   * first matching report, or null if the timeout elapses.
   *
   * @param {function}  predicate  `(reportId, data: Uint8Array) => boolean`
   * @param {number}    timeoutMs  Maximum wait time in milliseconds.
   * @returns {Promise<{reportId: number, data: Uint8Array}|null>}
   */
  _waitForReport(predicate, timeoutMs) {
    return new Promise(resolve => {
      let timer = null;

      const handler = (event) => {
        const data = new Uint8Array(event.data.buffer);
        if (predicate(event.reportId, data)) {
          clearTimeout(timer);
          this._device.removeEventListener('inputreport', handler);
          resolve({ reportId: event.reportId, data });
        }
      };

      this._device.addEventListener('inputreport', handler);

      timer = setTimeout(() => {
        this._device.removeEventListener('inputreport', handler);
        resolve(null);
      }, timeoutMs);
    });
  }

  /* -----------------------------------------------------------
   *  Device Name & Serial Number queries
   * --------------------------------------------------------- */

  /**
   * Query the real mouse name via HID++ 2.0 DEVICE_NAME feature (0x0005).
   *
   * The USB Receiver reports its own name ("USB Receiver") as the
   * HIDDevice.productName.  The actual wireless mouse name must be
   * fetched through the protocol.
   *
   * Function 0 on DEVICE_NAME = getDeviceNameCount  -> returns name length
   * Function 1 on DEVICE_NAME = getDeviceName       -> returns name chars
   *
   * @returns {Promise<string>}  The mouse name, or empty string on failure.
   */
  async _queryDeviceName() {
    try {
      // Step 1: discover DEVICE_NAME feature index.
      const nameIdx = await this._discoverFeatureIndex(FEATURE_ID.DEVICE_NAME);
      if (!nameIdx) return '';
      this._deviceNameFeatureIndex = nameIdx;

      // Step 2: getDeviceNameCount — function 0.
      // Send: [DevIdx, nameIdx, (0<<4)|SW_ID, 0, 0, 0]
      const countResp = this._waitForReport(
        (rid, d) => d[0] === DEVICE_INDEX && d[1] === nameIdx,
        2000,
      );
      await this._sendReport(HIDPP.SHORT, [
        DEVICE_INDEX, nameIdx, (0x00 << 4) | 0x0D, 0x00, 0x00, 0x00,
      ]);
      const countData = await countResp;
      if (!countData) return '';
      const nameLen = countData.data[3];
      if (nameLen === 0 || nameLen > 50) return '';

      // Step 3: getDeviceName — function 1.
      // May need multiple calls for long names (each returns up to 16 chars).
      let fullName = '';
      let offset = 0;
      while (offset < nameLen) {
        const nameResp = this._waitForReport(
          (rid, d) => d[0] === DEVICE_INDEX && d[1] === nameIdx && ((d[2] >> 4) & 0x0F) === 1,
          2000,
        );
        await this._sendReport(HIDPP.SHORT, [
          DEVICE_INDEX, nameIdx, (0x01 << 4) | 0x0D, offset, 0x00, 0x00,
        ]);
        const nameData = await nameResp;
        if (!nameData) break;

        // Characters start at data[3] in a long report.
        const chunkStart = 3;
        const chunkMax = nameData.reportId === HIDPP.LONG ? 16 : 3;
        for (let i = 0; i < chunkMax && offset + i < nameLen; i++) {
          const ch = nameData.data[chunkStart + i];
          if (ch === 0) break;
          fullName += String.fromCharCode(ch);
        }
        offset += chunkMax;
      }

      return fullName.trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * Query the device serial number via HID++ 2.0.
   *
   * Uses DEVICE_FW_VERSION feature (0x0003), function 0 = getDeviceInfo.
   * Response data[3..6] contains a 4-byte unit ID (8-char hex string)
   * that serves as a unique identifier per device.
   *
   * Also tries to read from the entity info which contains the
   * hardware serial: function 1 = getFwInfo for entity 0.
   *
   * @returns {Promise<string>}
   */
  async _querySerialNumber() {
    try {
      const fwIdx = await this._discoverFeatureIndex(FEATURE_ID.DEVICE_FW);
      if (!fwIdx) return '';

      // getFwInfo(entityIdx=0) — function 1
      // Returns: data[3..6] = FW prefix, data[7..10] = FW version
      // But for serial we want getDeviceInfo — function 0
      // which returns data[3..6] = unit ID (unique per device).
      const resp = this._waitForReport(
        (rid, d) => d[0] === DEVICE_INDEX && d[1] === fwIdx,
        2000,
      );
      await this._sendReport(HIDPP.SHORT, [
        DEVICE_INDEX, fwIdx, (0x00 << 4) | 0x0D, 0x00, 0x00, 0x00,
      ]);
      const data = await resp;
      if (!data) return '';

      // Entity count is at data[3]; unit ID / serial is in the FW entity.
      // Try function 1 (getFwInfo) for entity 0 to get fw prefix as serial.
      const fwResp = this._waitForReport(
        (rid, d) => d[0] === DEVICE_INDEX && d[1] === fwIdx && ((d[2] >> 4) & 0x0F) === 1,
        2000,
      );
      await this._sendReport(HIDPP.SHORT, [
        DEVICE_INDEX, fwIdx, (0x01 << 4) | 0x0D, 0x00, 0x00, 0x00,
      ]);
      const fwData = await fwResp;
      if (!fwData) return '';

      // data[3..6] = FW type + prefix, data[7..9] = fw build
      // Use bytes 3-10 as a hex serial identifier.
      const serialBytes = fwData.data.slice(3, 11);
      return Array.from(serialBytes)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join('');
    } catch (_) {
      return '';
    }
  }

  /* -----------------------------------------------------------
   *  IRoot Feature Discovery (Feature 0x0000)
   * --------------------------------------------------------- */

  /**
   * Discover the runtime feature index for a given feature ID using
   * the IRoot (0x0000) getFeatureIndex function.
   *
   * HID++ 2.0 maps feature IDs to per-device indices at runtime.
   * The root feature is always at index 0x00.
   *
   * Send: Short report (0x10)
   *   [DEVICE_INDEX, 0x00, 0x0D, featureId_HI, featureId_LO, 0x00]
   *
   * Response: Long report (0x11)
   *   data[0] == DEVICE_INDEX, data[1] == 0x00
   *   data[3] == discovered feature index
   *
   * @param {number} featureId  16-bit feature ID (e.g. 0x1004).
   * @returns {Promise<number|null>}  Feature index, or null on timeout.
   */
  async _discoverFeatureIndex(featureId) {
    const featureHigh = (featureId >> 8) & 0xFF;
    const featureLow  = featureId & 0xFF;

    // Set up listener before sending to avoid race.
    const responsePromise = this._waitForReport(
      (reportId, data) =>
        reportId === HIDPP.LONG &&
        data[0] === DEVICE_INDEX &&
        data[1] === 0x00,
      2000,
    );

    await this._sendReport(HIDPP.SHORT, [
      DEVICE_INDEX,
      0x00,        // IRoot feature index is always 0
      0x0D,        // function index | SW_ID nibble
      featureHigh,
      featureLow,
      0x00,
    ]);

    const response = await responsePromise;
    if (!response) return null;

    return response.data[3];
  }

  /* -----------------------------------------------------------
   *  DPI (3-step handshake)
   * --------------------------------------------------------- */

  /**
   * Set the sensor DPI using the Logitech 3-step handshake:
   *   1. Prepare  (report 0x10)
   *   2. DPI Set  (report 0x11)
   *   3. Confirm  (report 0x10)
   *
   * Each step is separated by 50 ms.
   *
   * @param {number} dpi  Target DPI value (e.g. 400, 800, 1600, 3200, 6400).
   * @returns {Promise<boolean>}  true on success.
   */
  async setDPI(dpi) {
    if (!this.isConnected()) {
      throw new Error('Device is not connected.');
    }

    dpi = Math.max(100, Math.min(25600, Math.round(dpi)));

    const dpiHigh = (dpi >> 8) & 0xFF;
    const dpiLow  = dpi & 0xFF;

    // LED index: match a preset, or 0 for custom value.
    const presetIdx = DPI_PRESETS.indexOf(dpi);
    const ledIndex  = presetIdx >= 0 ? presetIdx + 1 : 0;

    // Step 1: Prepare
    await this._sendReport(HIDPP.SHORT, [
      DEVICE_INDEX,
      FEATURE.PREPARE,
      0x2A,
      0x01,
      0x00,
      0x00,
    ]);
    await _sleep(50);

    // Step 2: DPI Set (long report -- 16 payload bytes)
    await this._sendReport(HIDPP.LONG, [
      DEVICE_INDEX,
      FEATURE.DPI,
      0x3A,
      0x00,
      dpiHigh,
      dpiLow,
      ledIndex,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    await _sleep(50);

    // Step 3: Confirm
    await this._sendReport(HIDPP.SHORT, [
      DEVICE_INDEX,
      FEATURE.CONFIRM,
      SW_ID,
      0x00,
      0x00,
      0x00,
    ]);

    return true;
  }

  /* -----------------------------------------------------------
   *  Polling rate
   * --------------------------------------------------------- */

  /**
   * Set the USB polling rate.
   *
   * Uses IRoot to discover the REPORT_RATE (0x8060) feature index,
   * then sends the rate-change command. Falls back to index 0x0A if
   * discovery times out.
   *
   * @param {number} rateHz  One of 125, 250, 500, 1000.
   * @returns {Promise<boolean>}
   */
  async setPollingRate(rateHz) {
    if (!this.isConnected()) {
      throw new Error('Device is not connected.');
    }

    const rateValue = POLLING_MAP[rateHz];
    if (rateValue === undefined) {
      throw new Error(
        `Unsupported polling rate ${rateHz} Hz. ` +
        `Accepted values: ${Object.keys(POLLING_MAP).join(', ')}`,
      );
    }

    // Resolve or reuse the cached feature index.
    if (this._reportRateFeatureIndex === null) {
      const idx = await this._discoverFeatureIndex(FEATURE_ID.REPORT_RATE);
      this._reportRateFeatureIndex = idx !== null ? idx : 0x0A;
    }

    await this._sendReport(HIDPP.SHORT, [
      0xFF,
      this._reportRateFeatureIndex,
      0x2E,
      rateValue,
      0x00,
      0x00,
    ]);

    return true;
  }

  /* -----------------------------------------------------------
   *  Battery
   * --------------------------------------------------------- */

  /**
   * Query battery level and charging state.
   *
   * Tries UNIFIED_BATTERY (0x1004) first, then falls back to
   * BATTERY_STATUS (0x1000). The query is sent twice with a 500 ms
   * gap to wake devices that are in deep sleep.
   *
   * Response parsing:
   *   data[3] = battery percentage (0-100)
   *   data[5] = charging status (see BATTERY_STATUS_MAP)
   *
   * @returns {Promise<{level: number, charging: boolean, status: string}>}
   */
  async getBattery() {
    if (!this.isConnected()) {
      throw new Error('Device is not connected.');
    }

    // Resolve battery feature index (try unified first, then legacy).
    if (this._batteryFeatureIndex === null) {
      let idx = await this._discoverFeatureIndex(FEATURE_ID.UNIFIED_BATTERY);
      if (idx === null) {
        idx = await this._discoverFeatureIndex(FEATURE_ID.BATTERY_STATUS);
      }
      if (idx === null) {
        throw new Error('Battery feature not found on this device.');
      }
      this._batteryFeatureIndex = idx;
    }

    const batteryIndex = this._batteryFeatureIndex;

    const queryPayload = [
      DEVICE_INDEX,
      batteryIndex,
      0x1D,
      0x00,
      0x00,
      0x00,
    ];

    // Set up listener before sending.
    const responsePromise = this._waitForReport(
      (reportId, data) =>
        data[0] === DEVICE_INDEX &&
        data[1] === batteryIndex,
      8000,
    );

    // Send query twice (500 ms apart) to wake the device.
    await this._sendReport(HIDPP.SHORT, queryPayload);
    await _sleep(500);
    await this._sendReport(HIDPP.SHORT, queryPayload);

    const response = await responsePromise;

    if (!response) {
      throw new Error('Battery query timed out (8 s). Device may be asleep or out of range.');
    }

    const percent        = response.data[3];
    const chargingByte   = response.data[5];
    const chargingStatus = BATTERY_STATUS_MAP[chargingByte] || 'Unknown';
    const isCharging     = chargingByte === 0x01 || chargingByte === 0x02;

    return {
      level:    Math.min(100, Math.max(0, percent)),
      charging: isCharging,
      status:   chargingStatus,
    };
  }
}
