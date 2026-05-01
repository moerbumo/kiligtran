import { Construct } from 'constructs';
import { ApplicationStack } from '../lib/application-stack';
import { ApplicationStackPoc } from '../lib/application-stack-poc';
import { DashboardCommonStack } from '../lib/dashboard-common-stack';
import { DashboardStack } from '../lib/dashboard-stack';
import {
  metricFilterPropsBatch,
  metricFilterPropsChannelAdapter,
  metricFilterPropsChannelReceiver,
  metricFilterPropsService,
  metricFilterPropsSplitter,
} from '../lib/metrics-filter-props';
import { envVarsBatch, envVarsChannelAdapter, envVarsChannelReceiver, envVarsService, envVarsSplitter } from '../lib/container-env-vars';
import { capitalize, generateListenerRulePriority, getEcsTaskCount, isDev, isPrd } from '../lib/utils';
import { CONTEXT_PATH } from '../lib/constants';
import { generateStackName } from '../lib/names';
import { envConfig } from '../configs/env-configs';

export const applicationStacks = (scope: Construct, appVersion: string) => {
  const commonParams = {
    appVersion,
    applicationDockerImageTag: appVersion,
    ecsTaskDesireCount: getEcsTaskCount(),
  };

  const ECR_REPO_PREFIX = 'cmpf';

  // 作成するアプリケーションスタック
  // Service
  const operateTargetAPIKeys = Object.entries(envConfig.OperateTargetAPIKeys);
  operateTargetAPIKeys.forEach(([index, targetApiKey]) => {
    new ApplicationStack(scope, `${capitalize(targetApiKey)}ServiceStack`, {
      ...commonParams,
      stackName: generateStackName('cmpf-service', targetApiKey, appVersion),
      targetContainer: 'cmpf_service',
      targetSubGroup: targetApiKey,
      ecrRepoName: `${ECR_REPO_PREFIX}/service`,
      containerEnvVars: envVarsService(targetApiKey, appVersion),
      ecsTaskDesireCount: isPrd() && targetApiKey === 'pluswa' ? 16 : commonParams.ecsTaskDesireCount,
      apiPath: `/${targetApiKey}${CONTEXT_PATH.service}/${appVersion}/`,
      metricFilterProps: metricFilterPropsService(targetApiKey, appVersion),
      albListenerRulePriority: generateListenerRulePriority(+index),
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    });
  });

  // Splitter
  operateTargetAPIKeys.forEach(([index, targetApiKey]) => {
    new ApplicationStack(scope, `${capitalize(targetApiKey)}SplitterStack`, {
      ...commonParams,
      stackName: generateStackName('cmpf-splitter', targetApiKey, appVersion),
      targetContainer: 'cmpf_splitter',
      targetSubGroup: targetApiKey,
      ecrRepoName: `${ECR_REPO_PREFIX}/service`,
      containerEnvVars: envVarsSplitter(targetApiKey, appVersion),
      ecsTaskDesireCount: isPrd() && targetApiKey === 'pluswa' ? 16 : commonParams.ecsTaskDesireCount,
      apiPath: `/${targetApiKey}${CONTEXT_PATH.splitter}/${appVersion}/`,
      metricFilterProps: metricFilterPropsSplitter(targetApiKey, appVersion),
      albListenerRulePriority: generateListenerRulePriority(+index + 35),
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    });
  });

  // ChannelAdapter
  envConfig.OperateTargetChannelAdapterChannels.forEach(({ channel, numberOfTasks }, index) => {
    new ApplicationStack(scope, `${capitalize(channel)}ChannelAdapterStack`, {
      ...commonParams,
      stackName: generateStackName('cmpf-channeladapter', channel, appVersion),
      targetContainer: 'channeladapter',
      targetSubGroup: channel,
      ecrRepoName: `${ECR_REPO_PREFIX}/channeladapter`,
      containerEnvVars: envVarsChannelAdapter(channel, appVersion),
      ecsTaskDesireCount: numberOfTasks,
      apiPath: `/${channel}${CONTEXT_PATH.channelAdapter}/${appVersion}/`,
      metricFilterProps: metricFilterPropsChannelAdapter(
        channel,
        operateTargetAPIKeys.map(([_, targetApiKey]) => targetApiKey),
        appVersion
      ),
      albListenerRulePriority: generateListenerRulePriority(index + 70),
      env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    });
  });

  // ChannelReceiver
  new ApplicationStack(scope, 'ChannelReceiverStack', {
    ...commonParams,
    stackName: generateStackName('cmpf-channelreceiver', null, appVersion),
    targetContainer: 'cmpf_channelreceiver',
    ecrRepoName: `${ECR_REPO_PREFIX}/channelreceiver`,
    containerEnvVars: envVarsChannelReceiver(appVersion),
    ecsTaskDesireCount: isDev() ? 1 : 4,
    apiPath: `${CONTEXT_PATH.channelReceiver}/${appVersion}/`,
    metricFilterProps: metricFilterPropsChannelReceiver(
      operateTargetAPIKeys.map(([_, targetApiKey]) => targetApiKey),
      appVersion
    ),
    albListenerRulePriority: generateListenerRulePriority(90),
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });

  // Batch
  new ApplicationStack(scope, 'BatchStack', {
    ...commonParams,
    stackName: generateStackName('cmpf-batch', null, appVersion),
    targetContainer: 'cmpf_batch',
    ecrRepoName: `${ECR_REPO_PREFIX}/batch`,
    containerEnvVars: envVarsBatch(appVersion),
    apiPath: `${CONTEXT_PATH.batch}/${appVersion}/`,
    metricFilterProps: metricFilterPropsBatch(appVersion),
    albListenerRulePriority: generateListenerRulePriority(91),
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });

  // Dashboard
  new DashboardCommonStack(scope, 'DashboardCommonStack', {
    stackName: generateStackName('cmpf-dashboard', 'common', appVersion),
    appVersion,
  });
  operateTargetAPIKeys.forEach(([_, targetApiKey]) => {
    new DashboardStack(scope, `${capitalize(targetApiKey)}DashboardStack`, {
      stackName: generateStackName('cmpf-dashboard', targetApiKey, appVersion),
      apiKey: targetApiKey,
      appVersion,
    });
  });


  // PoC
  operateTargetAPIKeys.forEach(([_, targetApiKey]) => {
    new DashboardStack(scope, `${capitalize(targetApiKey)}DashboardStack`, {
      stackName: generateStackName('cmpf-dashboard', targetApiKey, appVersion),
      apiKey: targetApiKey,
      appVersion,
    });
  });

  // POC用：Mail ChannelAdapter のネイティブBlue/Green検証スタック
  const pocVersion = 'v1-poc'; // 検証用の仮バージョン（2回目のDeploy時は v2-poc 等に変更して検証）

  new ApplicationStackPoc(scope, 'MailChannelAdapterStack-POC', {
    ...commonParams, // ecsTaskDesireCount 等のベース設定を継承

    appVersion: pocVersion, // 型定義エラー回避用

    // イメージ自体は既存のものを流用し、ビルド時間をゼロにする
    applicationDockerImageTag: appVersion,

    targetContainer: 'channeladapter',
    targetSubGroup: 'mail',
    ecrRepoName: `${ECR_REPO_PREFIX}/channeladapter`,

    // MQの物理隔離を検証するため、環境変数には新しい pocVersion を注入！
    containerEnvVars: envVarsChannelAdapter('mail', pocVersion),

    // PoC用なので1タスクのみ起動（コストと時間の節約）
    ecsTaskDesireCount: 1,

    // APIパスも新しいpocVersionでルーティング
    apiPath: `/mail${CONTEXT_PATH.channelAdapter}/${pocVersion}/`,

    // 既存のメトリクス生成ロジックを流用（エラー回避）
    metricFilterProps: metricFilterPropsChannelAdapter(
      'mail',
      operateTargetAPIKeys.map(([_, targetApiKey]) => targetApiKey),
      pocVersion
    ),

    // 既存の ALB Listener Rule と絶対に競合しない優先度を指定
    albListenerRulePriority: 999,

    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  });

};
