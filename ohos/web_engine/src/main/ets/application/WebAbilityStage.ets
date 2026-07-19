// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import AbilityStage from '@ohos.app.ability.AbilityStage';
import { CommandType, ConfigData, ContextType } from '../common/Constants';
import JsBindingUtils from '../utils/JsBindingUtils';
import Want from '@ohos.app.ability.Want';
import lazy { GlobalThisHelper } from '../utils/GlobalThisHelper';
import lazy { NativeContext, BrowserCloseResponse } from '../interface/CommonInterface';
import lazy { CommonDependencyProvider } from '../common/CommonDependencyProvider';
import { AbilityConstant } from '@kit.AbilityKit';
import LogUtil from '../utils/LogUtil';

const TAG: string = 'WebAbilityStage';
const DELAYED_TIME = 0;

export class WebAbilityStage extends AbilityStage {

  private nativeContext: NativeContext | undefined = undefined;
  private static SLEEP_INTERVAL_MS = 10;
  private static MAXIMUM_NUM_OF_SLEEP_CYCLES = 250;

  onCreate(): void {
    this.runTaskAsync();
  }

  onAcceptWant(want: Want): string {
    let instanceKey = want.parameters?.instanceKey;
    if (instanceKey) {
      return instanceKey.toString();
    }
    if (GlobalThisHelper.isLaunched()) {
      let widgetId = this.nativeContext?.GetLastActiveWidgetId();
      if (widgetId) {
        return ConfigData.WINDOW_PREFIX + widgetId;
      }
    }
    return ConfigData.DEFAULT_WINDOW_ID;
  }

  onPrepareTermination(): AbilityConstant.PrepareTermination {
    LogUtil.info(TAG, 'WebAbilityStage onPrepareTermination');
    this.nativeContext?.ExecuteCommand(CommandType.kAppQuit, { is_sync: false });
    return AbilityConstant.PrepareTermination.TERMINATE_IMMEDIATELY;
  }

  async onPrepareTerminationAsync(): Promise<AbilityConstant.PrepareTermination> {
    LogUtil.info(TAG, "ability stage prepare to quit async and app exit");
    if (!this.nativeContext) {
      this.nativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
    }
    if (GlobalThisHelper.isLaunched()) {
      this.nativeContext?.ExecuteCommand(
        CommandType.kAppExit, { is_sync: false });
    } else {
      return AbilityConstant.PrepareTermination.TERMINATE_IMMEDIATELY;
    }
    let response: BrowserCloseResponse = BrowserCloseResponse.kUndetermined;
    let cnt = 0;
    for (let i = 0; i < WebAbilityStage.MAXIMUM_NUM_OF_SLEEP_CYCLES; i++) {
      cnt++;
      await this.sleep(WebAbilityStage.SLEEP_INTERVAL_MS);
      response = this.nativeContext.GetAppCloseResponse();
      if (response !== BrowserCloseResponse.kUndetermined) {
        break;
      }
    }
    LogUtil.info(TAG, "ability stage prepare to quit async done response:" + response + " cnt:" + cnt);
    if (response === BrowserCloseResponse.kClosingContinue || response === BrowserCloseResponse.kClosed) {
      return AbilityConstant.PrepareTermination.TERMINATE_IMMEDIATELY;
    }
    return AbilityConstant.PrepareTermination.CANCEL;
  }

  sleep(delay: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  onDestroy(): void {
    LogUtil.info(TAG, "ability stage on destroy");
  }

  private runTaskAsync() {
    setTimeout(() => {
      JsBindingUtils.initNativeContext(ContextType.kMainProcess);
      this.nativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
      if (!GlobalThisHelper.isLaunched()) {
        let appContext = this.context.getApplicationContext();
        GlobalThisHelper.appInit(new CommonDependencyProvider(appContext));
      }
      import('../jsbindings/JsBindingMethod').then((ns:ESObject) => {
        ns.JsBindingMethod.bind();
      }).catch(()=>{
        LogUtil.error(TAG, 'import failed');
      });
    }, DELAYED_TIME)
  }
}
