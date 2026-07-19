// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable, inject } from 'inversify';
import common from '@ohos.app.ability.common';
import { deviceInfo } from '@kit.BasicServicesKit';
import fileUri from '@ohos.file.fileuri';
import { fileManagerService } from '@kit.FileManagerServiceKit';
import { OpenLinkOptions, Want, wantConstant } from '@kit.AbilityKit';

import { BaseAdapter } from '../common/BaseAdapter';
import { BusinessError } from '@kit.BasicServicesKit';
import { ContextAdapter } from './ContextAdapter';
import LaunchHelper from '../utils/LaunchHelper';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';

const TAG: string = 'FileManagerAdapter';

@injectable()
export class FileManagerAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  @LogMethod
  openItemInFolder(filePath: string) {
    let uri = fileUri.getUriFromPath(filePath);
    let link = 'filemanager://openDirectory';
    let openLinkOptions: OpenLinkOptions = {
      appLinkingOnly: false,
      parameters: {
        'fileUri': uri
      }
    };
    try {
      (this.ctxAdapter.getActiveContext() as common.UIAbilityContext).openLink(link, openLinkOptions);
    } catch (error) {
      LogUtil.error(TAG, `openItemInFolder openLink try to open uri ${uri} fail, err = ${JSON.stringify(error)}`);
    }
  }

  @LogMethod
  openVerifiedItem(filePath: string) {
    let uri = fileUri.getUriFromPath(filePath);
    const want: Want = {
      // Configure read and write permissions for shared files,
      // such as granting read and write authorization to shared applications
      flags: wantConstant.Flags.FLAG_AUTH_WRITE_URI_PERMISSION |
             wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION,
      action: "ohos.want.action.viewData",
      uri: uri
    }
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }

  @LogMethod
  openUrlInDefaultBrowser(url: string) {
    let want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url
    };
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }

  @LogMethod
  openExternal(urlStr: string, options: string) {
    const want: Want = {
      flags: wantConstant.Flags.FLAG_START_WITHOUT_TIPS,
      uri: urlStr,
      action: "ohos.want.action.viewData"
    }
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }

  @LogMethod
  deleteFileToTrash(filePath: string, callback: (result: boolean) => void) {
    if (deviceInfo.sdkApiVersion < 17) {
      LogUtil.error(TAG, "The current api version is too low and needs to be upgraded to at least api17, current api version is " + deviceInfo.sdkApiVersion);
      callback(false);
      return;
    }
    let uri = fileUri.getUriFromPath(filePath);
    fileManagerService.deleteToTrash(uri).then((result) => {
      if(result){
        LogUtil.info(TAG, "Successfully deleted files to trash, trashUri: " + filePath);
        callback(true);
      } else {
        LogUtil.error(TAG, "Failed to delete the file to trash, trashUri: " + filePath);
        callback(false);
      }
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, "Failed to delete the file to trash, errMessage:" + JSON.stringify(err));
      callback(false);
    })
  }
}