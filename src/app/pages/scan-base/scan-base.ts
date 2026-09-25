import { PermissionsService, PermissionStatus, PermissionTypes, QrScannerService } from '@airgap/angular-core'
import { Inject } from '@angular/core'
import { Platform } from '@ionic/angular'
import { ZXingScannerComponent } from '@zxing/ngx-scanner'
import { Observable, ReplaySubject } from 'rxjs'
import { SecurityUtilsPlugin } from 'src/app/capacitor-plugins/definitions'
import { SECURITY_UTILS_PLUGIN } from 'src/app/capacitor-plugins/injection-tokens'

export class ScanBasePage {
  public zxingScanner?: ZXingScannerComponent
  public availableDevices: MediaDeviceInfo[]
  public selectedDevice: MediaDeviceInfo | null = null

  public hasCameras: boolean = false

  private readonly _hasCameraPermission: ReplaySubject<boolean> = new ReplaySubject()
  public readonly hasCameraPermission: Observable<boolean> = this._hasCameraPermission.asObservable()

  public readonly isMobile: boolean
  public readonly isElectron: boolean
  public readonly isBrowser: boolean

  private scannerActive: boolean = false

  constructor(
    protected platform: Platform,
    protected scanner: QrScannerService,
    protected permissionsProvider: PermissionsService,
    @Inject(SECURITY_UTILS_PLUGIN) private readonly securityUtils: SecurityUtilsPlugin
  ) {
    this.isMobile = this.platform.is('hybrid')
    this.isElectron = this.platform.is('electron')
    this.isBrowser = !(this.isMobile || this.isElectron)
  }

  public async ionViewWillEnter(): Promise<void> {
    this.scannerActive = true
    if (this.isMobile || this.isElectron) {
      await this.platform.ready()
      if (!this.scannerActive) {
        return
      }
      await this.checkCameraPermissionsAndActivate()
    }
  }

  public async requestPermission(): Promise<void> {
    if (this.isMobile) {
      await this.permissionsProvider.userRequestsPermissions([PermissionTypes.CAMERA])
      await this.securityUtils.waitForOverlayDismiss()
      await this.checkCameraPermissionsAndActivate()
    } else if (this.isElectron) {
      this.startScanBrowser()
    }
  }

  public async checkCameraPermissionsAndActivate(): Promise<void> {
    const permission: PermissionStatus = await this.permissionsProvider.hasCameraPermission()

    if (!this.scannerActive) {
      return
    }

    if (permission === PermissionStatus.GRANTED) {
      this._hasCameraPermission.next(true)
      this.startScan()
    } else {
      this._hasCameraPermission.next(false)
    }
  }

  public ionViewDidEnter(): void {
    if (this.isBrowser && this.scannerActive) {
      this._hasCameraPermission.next(true)
      this.startScanBrowser()
    }
  }

  public ionViewWillLeave(): void {
    this.stopScan()
  }

  protected stopScan() {
    this.scannerActive = false
    if (this.isMobile) {
      this.scanner.destroy()
    } else if (this.zxingScanner) {
      this.zxingScanner.enable = false
    }
  }

  public startScan(): void {
    if (!this.scannerActive) {
      return
    }
    if (this.isMobile) {
      this.startScanMobile()
    } else {
      this.startScanBrowser()
    }
  }

  public checkScan(resultString: string): void {
    console.error(`The checkScan method needs to be overwritten. Ignoring text ${resultString}`)
  }

  private startScanMobile() {
    this.scanner.scan(
      (text) => {
        if (this.scannerActive) {
          this.checkScan(text)
        }
      },
      (error) => {
        if (this.scannerActive) {
          console.warn(error)
          this.startScan()
        }
      }
    )
  }

  private startScanBrowser() {
    if (this.zxingScanner && !this.zxingScanner.enabled) {
      this.zxingScanner.enable = true
      this.zxingScanner.camerasNotFound.subscribe((_devices: MediaDeviceInfo[]) => {
        console.error('An error has occurred when trying to enumerate your video-stream-enabled devices.')
      })

      if (this.selectedDevice) {
        // Not the first time that we open scanner
        this.zxingScanner.device = this.selectedDevice
      }

      this.zxingScanner.camerasFound.subscribe((devices: MediaDeviceInfo[]) => {
        this.hasCameras = true
        this.availableDevices = devices
        this.selectedDevice = devices[0]
      })
    }
  }
}
