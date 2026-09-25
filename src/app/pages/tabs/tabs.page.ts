import { Component } from '@angular/core'
import { IonTabs } from '@ionic/angular'
import { QrScannerService } from '@airgap/angular-core'

@Component({
  selector: 'airgap-tabs',
  templateUrl: 'tabs.page.html',
  styleUrls: ['tabs.page.scss']
})
export class TabsPage {
  private activeTab?: HTMLElement

  constructor(private readonly scanner: QrScannerService) {}

  tabChange(tabsRef: IonTabs) {
    if (tabsRef.getSelected() !== 'tab-scan') {
      if (this.activeTab?.tagName === 'AIRGAP-TAB-SCAN') {
        this.propagateToActiveTab('ionViewWillLeave')
      }
      this.scanner.destroy()
    }
    this.activeTab = tabsRef?.outlet?.activatedView?.element
  }

  ionViewWillEnter() {
    this.propagateToActiveTab('ionViewWillEnter')
  }

  ionViewWillLeave() {
    this.propagateToActiveTab('ionViewWillLeave')
    this.scanner.destroy()
  }

  private propagateToActiveTab(eventName: string) {
    if (this.activeTab) {
      this.activeTab.dispatchEvent(new CustomEvent(eventName))
    }
  }
}
