/**
 * WebUSB 协议实现
 * 用于通过 USB Control Transfer 控制鼠标设置
 * 适用于不支持 WebHID 的设备或需要低级别控制的场景
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

// USB 请求
const USB_REQUEST = {
  SET_REPORT: 0x09,
  GET_REPORT: 0x01,
};

// Report Types
const REPORT_TYPE = {
  INPUT: 0x01,
  OUTPUT: 0x02,
  FEATURE: 0x03,
};

export class USBMouseProtocol implements IMouseProtocol {
  private device: USBDevice | null = null;
  private deviceInfo: MouseDeviceInfo | null = null;
  private interfaceNumber: number = 0;
  private currentSettings: MouseSettings = {
    dpi: 800,
    pollingRate: 1000,
    activeProfile: 1
  };

  // 设备过滤器 - Logitech PRO X SUPERLIGHT 专用
  private readonly filters: USBDeviceFilter[] = [
    // PRO X SUPERLIGHT 第一代
    { vendorId: 0x046D, productId: 0xC094 },
    // PRO X SUPERLIGHT 2
    { vendorId: 0x046D, productId: 0xC09B },
    // Lightspeed 无线接收器
    { vendorId: 0x046D, productId: 0xC54D },
    // Logitech 通用 (备用)
    { vendorId: 0x046D },
  ];

  async connect(): Promise<boolean> {
    try {
      // 检查 WebUSB 支持
      if (!('usb' in navigator)) {
        throw new Error('WebUSB API 不受支持');
      }

      // 请求设备访问
      this.device = await navigator.usb.requestDevice({
        filters: this.filters
      });

      // 打开设备
      await this.device.open();

      // 选择配置
      if (this.device.configuration === null) {
        await this.device.selectConfiguration(1);
      }

      // 查找 HID 接口
      const hidInterface = this.device.configuration?.interfaces.find(
        (iface: USBInterface) => iface.alternate.interfaceClass === 0x03 // HID Class
      );

      if (hidInterface) {
        this.interfaceNumber = hidInterface.interfaceNumber;
        await this.device.claimInterface(this.interfaceNumber);
      } else {
        // 尝试使用第一个接口
        this.interfaceNumber = 0;
        await this.device.claimInterface(this.interfaceNumber);
      }

      // 保存设备信息
      this.deviceInfo = {
        vendorId: this.device.vendorId,
        productId: this.device.productId,
        productName: this.device.productName || 'Unknown Mouse',
        serialNumber: this.device.serialNumber ?? undefined,
      };

      console.log(`已连接 (USB): ${this.deviceInfo.productName}`);
      return true;
    } catch (error) {
      console.error('USB 连接失败:', error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      try {
        await this.device.releaseInterface(this.interfaceNumber);
        await this.device.close();
      } catch (error) {
        console.error('断开连接失败:', error);
      }
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
      // 构建 DPI 设置命令
      const reportId = 0x04;
      const dpiIndex = DPI_VALUES.indexOf(dpi) + 1;

      const data = new Uint8Array([
        reportId,
        0x01,           // 命令类型
        dpiIndex,       // DPI 索引
        dpi & 0xFF,     // DPI 低字节
        (dpi >> 8) & 0xFF, // DPI 高字节
        0x00, 0x00, 0x00
      ]);

      await this.sendControlTransfer(reportId, data);

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
      const reportId = 0x05;
      const rateIndex = POLLING_RATES.indexOf(rate);

      // 回报率映射: 125=8ms, 250=4ms, 500=2ms, 1000=1ms
      const intervalMap: Record<PollingRate, number> = {
        125: 0x08,
        250: 0x04,
        500: 0x02,
        1000: 0x01,
      };

      const data = new Uint8Array([
        reportId,
        0x01,
        intervalMap[rate],
        rateIndex,
        0x00, 0x00, 0x00, 0x00
      ]);

      await this.sendControlTransfer(reportId, data);

      this.currentSettings.pollingRate = rate;
      console.log(`回报率已设置为: ${rate}Hz`);
      return true;
    } catch (error) {
      console.error('设置回报率失败:', error);
      return false;
    }
  }

  async getSettings(): Promise<MouseSettings | null> {
    return { ...this.currentSettings };
  }

  private async sendControlTransfer(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.device) {
      throw new Error('设备未连接');
    }

    // SET_REPORT Control Transfer
    // wValue = (Report Type << 8) | Report ID
    const wValue = (REPORT_TYPE.FEATURE << 8) | reportId;

    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: USB_REQUEST.SET_REPORT,
      value: wValue,
      index: this.interfaceNumber,
    }, data as BufferSource);
  }

  async receiveControlTransfer(reportId: number, length: number): Promise<Uint8Array> {
    if (!this.device) {
      throw new Error('设备未连接');
    }

    const wValue = (REPORT_TYPE.FEATURE << 8) | reportId;

    const result = await this.device.controlTransferIn({
      requestType: 'class',
      recipient: 'interface',
      request: USB_REQUEST.GET_REPORT,
      value: wValue,
      index: this.interfaceNumber,
    }, length);

    if (result.data) {
      return new Uint8Array(result.data.buffer);
    }
    return new Uint8Array(0);
  }
}
