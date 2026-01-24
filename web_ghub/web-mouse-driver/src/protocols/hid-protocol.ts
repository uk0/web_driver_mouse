/**
 * WebHID 协议实现
 * 用于通过 HID Feature Reports 控制鼠标设置
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

// HID Report IDs (根据实际抓包数据调整)
const REPORT_ID = {
  DPI_SETTING: 0x04,      // DPI 设置报告 ID
  POLLING_RATE: 0x05,     // 回报率设置报告 ID
  READ_SETTINGS: 0x06,    // 读取设置报告 ID
};

// DPI 值到协议值的映射
const DPI_TO_PROTOCOL: Record<DPIValue, number> = {
  400: 0x01,
  800: 0x02,
  1600: 0x03,
  3200: 0x04,
  6400: 0x05,
};

// 回报率到协议值的映射 (1000/rate = 间隔ms)
const POLLING_TO_PROTOCOL: Record<PollingRate, number> = {
  125: 0x08,   // 8ms 间隔
  250: 0x04,   // 4ms 间隔
  500: 0x02,   // 2ms 间隔
  1000: 0x01,  // 1ms 间隔
};

export class HIDMouseProtocol implements IMouseProtocol {
  private device: HIDDevice | null = null;
  private deviceInfo: MouseDeviceInfo | null = null;
  private currentSettings: MouseSettings = {
    dpi: 800,
    pollingRate: 1000,
    activeProfile: 1
  };

  // 设备过滤器 - Logitech PRO X SUPERLIGHT 专用
  private readonly filters: HIDDeviceFilter[] = [
    // PRO X SUPERLIGHT HID 接口 (您的设备)
    { vendorId: 0x046D, productId: 0xC232 },
    // PRO X SUPERLIGHT 第一代
    { vendorId: 0x046D, productId: 0xC094 },
    // PRO X SUPERLIGHT 2
    { vendorId: 0x046D, productId: 0xC09B },
    // Lightspeed 无线接收器
    { vendorId: 0x046D, productId: 0xC54D },
  ];

  async connect(): Promise<boolean> {
    try {
      // 检查 WebHID 支持
      if (!('hid' in navigator)) {
        throw new Error('WebHID API 不受支持，请使用 Chrome 89+ 或 Edge 89+');
      }

      // 请求设备访问
      const devices = await navigator.hid.requestDevice({
        filters: this.filters
      });

      if (devices.length === 0) {
        console.log('未选择设备');
        return false;
      }

      this.device = devices[0];

      // 打开设备
      if (!this.device.opened) {
        await this.device.open();
      }

      // 保存设备信息
      this.deviceInfo = {
        vendorId: this.device.vendorId,
        productId: this.device.productId,
        productName: this.device.productName || 'Unknown Mouse',
      };

      // 设置输入报告监听
      this.device.addEventListener('inputreport', this.handleInputReport.bind(this));

      console.log(`已连接: ${this.deviceInfo.productName} (VID: 0x${this.deviceInfo.vendorId.toString(16)}, PID: 0x${this.deviceInfo.productId.toString(16)})`);

      // 尝试读取当前设置
      await this.getSettings();

      return true;
    } catch (error) {
      console.error('连接失败:', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.device && this.device.opened) {
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

  async setDPI(dpi: DPIValue): Promise<boolean> {
    if (!this.device || !this.device.opened) {
      throw new Error('设备未连接');
    }

    if (!DPI_VALUES.includes(dpi)) {
      throw new Error(`不支持的 DPI 值: ${dpi}`);
    }

    try {
      const protocolValue = DPI_TO_PROTOCOL[dpi];

      // 构建 DPI 设置命令
      // 命令格式: [Command Type, DPI Index, 0x00, 0x00, ...]
      const data = new Uint8Array([
        0x01,           // 命令类型: 设置
        protocolValue,  // DPI 索引
        0x00,           // X 轴 DPI (高字节)
        dpi & 0xFF,     // X 轴 DPI (低字节)
        (dpi >> 8) & 0xFF, // X 轴 DPI (高字节)
        0x00,           // Y 轴 DPI (低字节)
        dpi & 0xFF,     // Y 轴 DPI (低字节)
        (dpi >> 8) & 0xFF, // Y 轴 DPI (高字节)
      ]);

      await this.device.sendFeatureReport(REPORT_ID.DPI_SETTING, data);

      this.currentSettings.dpi = dpi;
      console.log(`DPI 已设置为: ${dpi}`);
      return true;
    } catch (error) {
      console.error('设置 DPI 失败:', error);
      return false;
    }
  }

  async setPollingRate(rate: PollingRate): Promise<boolean> {
    if (!this.device || !this.device.opened) {
      throw new Error('设备未连接');
    }

    if (!POLLING_RATES.includes(rate)) {
      throw new Error(`不支持的回报率: ${rate}`);
    }

    try {
      const protocolValue = POLLING_TO_PROTOCOL[rate];

      // 构建回报率设置命令
      const data = new Uint8Array([
        0x01,           // 命令类型: 设置
        protocolValue,  // 回报率值 (间隔)
        0x00,
        0x00,
      ]);

      await this.device.sendFeatureReport(REPORT_ID.POLLING_RATE, data);

      this.currentSettings.pollingRate = rate;
      console.log(`回报率已设置为: ${rate}Hz`);
      return true;
    } catch (error) {
      console.error('设置回报率失败:', error);
      return false;
    }
  }

  async getSettings(): Promise<MouseSettings | null> {
    if (!this.device || !this.device.opened) {
      return null;
    }

    try {
      // 尝试读取设备当前设置
      const report = await this.device.receiveFeatureReport(REPORT_ID.READ_SETTINGS);
      const data = new Uint8Array(report.buffer);

      // 解析设置数据 (格式根据实际协议调整)
      if (data.length >= 4) {
        const dpiIndex = data[1];
        const pollingIndex = data[2];

        // 反向映射
        const dpiEntry = Object.entries(DPI_TO_PROTOCOL).find(([_, v]) => v === dpiIndex);
        const pollingEntry = Object.entries(POLLING_TO_PROTOCOL).find(([_, v]) => v === pollingIndex);

        if (dpiEntry) {
          this.currentSettings.dpi = parseInt(dpiEntry[0]) as DPIValue;
        }
        if (pollingEntry) {
          this.currentSettings.pollingRate = parseInt(pollingEntry[0]) as PollingRate;
        }
      }
    } catch (error) {
      console.log('读取设置失败，使用默认值:', error);
    }

    return { ...this.currentSettings };
  }

  private handleInputReport(event: HIDInputReportEvent): void {
    const { reportId, data } = event;
    console.log(`收到输入报告 ID: ${reportId}, 数据:`, new Uint8Array(data.buffer));
  }

  // 发送原始命令 (用于调试和协议分析)
  async sendRawCommand(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.device || !this.device.opened) {
      throw new Error('设备未连接');
    }
    await this.device.sendFeatureReport(reportId, data as BufferSource);
  }

  // 接收原始报告 (用于调试)
  async receiveRawReport(reportId: number): Promise<Uint8Array> {
    if (!this.device || !this.device.opened) {
      throw new Error('设备未连接');
    }
    const report = await this.device.receiveFeatureReport(reportId);
    return new Uint8Array(report.buffer);
  }
}
