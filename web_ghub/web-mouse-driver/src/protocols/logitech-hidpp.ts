/**
 * Logitech HID++ 2.0 协议实现
 * 专门用于 PRO X SUPERLIGHT 等 Logitech 无线鼠标
 *
 * 重要发现：
 * - 需要连接 USB Receiver (046D:C547) 而不是鼠标本身
 * - 需要选择 UsagePage=0xFF00 的厂商专用接口
 * - G Hub 必须关闭，否则会独占接口
 */

import {
  IMouseProtocol,
  MouseDeviceInfo,
  MouseSettings,
  DPIValue,
  PollingRate,
  DPI_VALUES,
  POLLING_RATES
} from '../types/mouse';

// HID++ 2.0 Report IDs
const HIDPP = {
  SHORT_MSG: 0x10,    // 7 字节短消息
  LONG_MSG: 0x11,     // 20 字节长消息
};

// 设备索引
const DEVICE_INDEX = 0x01;  // 无线设备

// HID++ 功能索引 (从抓包分析得到)
const FEATURE = {
  CONFIRM: 0x07,       // 确认命令
  PREPARE: 0x0A,       // 准备命令
  DPI: 0x0B,           // DPI 设置
};

// SW ID (软件标识符) - 从抓包数据得到 0x0A
const SW_ID = 0x0A;

export class LogitechHIDPPProtocol implements IMouseProtocol {
  private device: HIDDevice | null = null;
  private deviceInfo: MouseDeviceInfo | null = null;
  private currentSettings: MouseSettings = {
    dpi: 800,
    pollingRate: 1000,
    activeProfile: 1
  };

  // 设备过滤器 - Logitech Lightspeed Receiver
  // 重要：必须连接 Receiver (C547) 而不是鼠标接口 (C232)
  private readonly filters: HIDDeviceFilter[] = [
    { vendorId: 0x046D, productId: 0xC547 },  // Lightspeed Receiver ✅
    { vendorId: 0x046D, productId: 0xC539 },  // Lightspeed Receiver 备用
    { vendorId: 0x046D, productId: 0xC52B },  // Unifying Receiver
    { vendorId: 0x046D },                      // 通用 Logitech
  ];

  async connect(): Promise<boolean> {
    try {
      if (!('hid' in navigator)) {
        throw new Error('WebHID API 不受支持');
      }

      // 请求设备
      const devices = await navigator.hid.requestDevice({ filters: this.filters });

      if (devices.length === 0) {
        return false;
      }

      // 查找具有 UsagePage=0xFF00 的设备（厂商专用配置接口）
      let targetDevice: HIDDevice | null = null;

      // 首先检查选择的设备
      for (const dev of devices) {
        if (this.hasVendorInterface(dev)) {
          targetDevice = dev;
          break;
        }
      }

      // 如果没找到，检查已授权的设备
      if (!targetDevice) {
        const grantedDevices = await navigator.hid.getDevices();
        for (const dev of grantedDevices) {
          if (dev.vendorId === 0x046D && this.hasVendorInterface(dev)) {
            targetDevice = dev;
            break;
          }
        }
      }

      // 如果还是没找到，使用第一个设备
      if (!targetDevice) {
        console.warn('未找到厂商专用接口，尝试使用第一个设备');
        targetDevice = devices[0];
      }

      this.device = targetDevice;

      if (!this.device.opened) {
        await this.device.open();
      }

      this.deviceInfo = {
        vendorId: this.device.vendorId,
        productId: this.device.productId,
        productName: this.device.productName || 'Logitech PRO X SUPERLIGHT',
      };

      // 监听输入报告
      this.device.addEventListener('inputreport', this.handleInputReport.bind(this));

      console.log(`✅ 已连接: ${this.deviceInfo.productName} (VID: 0x${this.deviceInfo.vendorId.toString(16).toUpperCase()}, PID: 0x${this.deviceInfo.productId.toString(16).toUpperCase()})`);
      console.log(`   Collections: ${this.device.collections.length}`);
      this.device.collections.forEach((c: HIDCollectionInfo, i: number) => {
        console.log(`   [${i}] UsagePage=0x${(c.usagePage ?? 0).toString(16)} Usage=0x${(c.usage ?? 0).toString(16)}`);
      });

      return true;
    } catch (error) {
      console.error('连接失败:', error);
      return false;
    }
  }

  /**
   * 检查设备是否有厂商专用接口 (UsagePage=0xFF00)
   */
  private hasVendorInterface(device: HIDDevice): boolean {
    return device.collections.some((c: HIDCollectionInfo) =>
      c.usagePage === 0xFF00 &&
      c.outputReports &&
      c.outputReports.length > 0
    );
  }

  async disconnect(): Promise<void> {
    if (this.device?.opened) {
      await this.device.close();
    }
    this.device = null;
    this.deviceInfo = null;
  }

  isConnected(): boolean {
    return this.device !== null && this.device.opened;
  }

  getDeviceInfo(): MouseDeviceInfo | null {
    return this.deviceInfo;
  }

  /**
   * 设置 DPI
   * 基于抓包数据分析 - 需要发送3条命令:
   * 1. 准备命令: 10 01 0A 2A 01 00 00
   * 2. DPI设置: 11 01 0B 3A 00 XX XX YY 00...
   * 3. 确认命令: 10 01 07 0A 00 00 00
   */
  async setDPI(dpi: DPIValue): Promise<boolean> {
    if (!this.device?.opened) {
      throw new Error('设备未连接');
    }

    if (!DPI_VALUES.includes(dpi)) {
      throw new Error(`不支持的 DPI 值: ${dpi}`);
    }

    try {
      const dpiIndex = DPI_VALUES.indexOf(dpi);
      const dpiHigh = (dpi >> 8) & 0xFF;
      const dpiLow = dpi & 0xFF;

      // 命令 1: 准备命令 (Report 0x10)
      // 抓包数据: 10 01 0A 2A 01 00 00
      const prepareCmd = new Uint8Array([
        DEVICE_INDEX,              // 0x01
        FEATURE.PREPARE,           // 0x0A
        (0x02 << 4) | SW_ID,       // 0x2A
        0x01,
        0x00,
        0x00
      ]);
      console.log('[OUT] 准备命令 (0x10):', this.toHex(prepareCmd));
      await this.device.sendReport(HIDPP.SHORT_MSG, prepareCmd);
      await this.delay(10);

      // 命令 2: DPI 设置 (Report 0x11)
      // 抓包数据: 11 01 0B 3A 00 0C 80 04 00...
      const dpiCmd = new Uint8Array([
        DEVICE_INDEX,              // 0x01
        FEATURE.DPI,               // 0x0B
        (0x03 << 4) | SW_ID,       // 0x3A
        0x00,                      // 档位索引
        dpiHigh,                   // DPI 高字节
        dpiLow,                    // DPI 低字节
        dpiIndex + 1,              // LED 颜色参数
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
      ]);
      console.log(`[OUT] DPI 设置 ${dpi} (0x11):`, this.toHex(dpiCmd));
      await this.device.sendReport(HIDPP.LONG_MSG, dpiCmd);
      await this.delay(10);

      // 命令 3: 确认命令 (Report 0x10)
      // 抓包数据: 10 01 07 0A 00 00 00
      const confirmCmd = new Uint8Array([
        DEVICE_INDEX,              // 0x01
        FEATURE.CONFIRM,           // 0x07
        SW_ID,                     // 0x0A
        0x00,
        0x00,
        0x00
      ]);
      console.log('[OUT] 确认命令 (0x10):', this.toHex(confirmCmd));
      await this.device.sendReport(HIDPP.SHORT_MSG, confirmCmd);

      this.currentSettings.dpi = dpi;
      console.log(`✅ DPI 已设置为: ${dpi}`);
      return true;
    } catch (error) {
      console.error('设置 DPI 失败:', error);
      return false;
    }
  }

  /**
   * 设置回报率
   * TODO: 需要抓包确认回报率命令格式
   */
  async setPollingRate(rate: PollingRate): Promise<boolean> {
    if (!this.device?.opened) {
      throw new Error('设备未连接');
    }

    if (!POLLING_RATES.includes(rate)) {
      throw new Error(`不支持的回报率: ${rate}`);
    }

    // TODO: 需要抓包分析回报率设置命令
    console.log(`⚠️ 回报率设置需要抓包确认: ${rate}Hz`);
    this.currentSettings.pollingRate = rate;
    return true;
  }

  async getSettings(): Promise<MouseSettings | null> {
    return { ...this.currentSettings };
  }

  /**
   * 发送原始 HID++ 命令 (用于调试)
   */
  async sendRawCommand(reportId: number, data: number[]): Promise<void> {
    if (!this.device?.opened) {
      throw new Error('设备未连接');
    }

    const uint8Data = new Uint8Array(data);
    console.log(`[OUT] Raw Report 0x${reportId.toString(16)}:`, this.toHex(uint8Data));
    await this.device.sendReport(reportId, uint8Data);
  }

  private handleInputReport(event: HIDInputReportEvent): void {
    const data = new Uint8Array(event.data.buffer);
    console.log(`[IN] Report 0x${event.reportId.toString(16)}:`, this.toHex(data));
  }

  private toHex(data: Uint8Array): string {
    return Array.from(data)
      .map(b => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
