import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elb,
  aws_ecr as ecr,
  aws_ec2 as ec2,
  aws_logs as logs,
  aws_iam as iam,
} from 'aws-cdk-lib';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { ContainerDefinitionOptions } from 'aws-cdk-lib/aws-ecs';
import { AdapterChannel, ApiKey, Container } from '../configs/types';
import { envConfig } from '../configs/env-configs';
import { isNotDev, isPrd } from './utils';

type ApplicationStackProps = {
  appVersion: string;
  targetContainer: Container;
  targetSubGroup?: ApiKey | AdapterChannel;
  ecrRepoName: string;
  applicationDockerImageTag: string;
  ecsTaskDesireCount: number;
  containerEnvVars: ContainerDefinitionOptions['environment'];
  apiPath: string;
  metricFilterProps: Omit<logs.MetricFilterProps, 'logGroup'>[];
  albListenerRulePriority: number;
} & StackProps;

export class ApplicationStackPoc extends Stack {
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    const {
      targetContainer,
      targetSubGroup,
      ecrRepoName,
      applicationDockerImageTag,
      ecsTaskDesireCount,
      containerEnvVars,
      apiPath,
      metricFilterProps,
      albListenerRulePriority,
    } = props;

    // POC用: 固定リソースのプレフィックス
    const pocPrefix = `poc-${targetSubGroup || 'def'}`;

    // CloudWatch Logs
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${targetContainer}/${pocPrefix}`,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY, // POC用途のため自動削除を許可
    });

    // 既存リソースの参照 (IAM, VPC, ECR, Cluster)
    const executionRole = iam.Role.fromRoleArn(this, 'ExecutionRole', envConfig.ECSService.ExecutionRoleArn, { mutable: false });
    const vpc = ec2.Vpc.fromLookup(this, 'vpc', { vpcId: envConfig.VpcId });
    const repository = ecr.Repository.fromRepositoryName(this, 'Repository', ecrRepoName);
    const cluster = ecs.Cluster.fromClusterAttributes(this, 'Cluster', { clusterName: envConfig.ECSService.ClusterName, vpc });

    // ECS タスク定義 (ファミリー名を固定)
    const cpu = targetContainer === 'cmpf_service' && isPrd() && targetSubGroup === 'pluswa' ? '2048' : targetContainer === 'cmpf_splitter' && isNotDev() ? '4096' : '512';
    const memory = targetContainer === 'cmpf_service' && isPrd() && targetSubGroup === 'pluswa' ? '4096' : targetContainer === 'cmpf_splitter' && isNotDev() ? '8192' : '2048';

    const taskDefinition = new ecs.TaskDefinition(this, 'TaskDefinition', {
      compatibility: ecs.Compatibility.FARGATE,
      cpu,
      memoryMiB: memory,
      family: `${targetContainer}-${pocPrefix}-task`,
      executionRole,
    });

    // コンテナ定義 (MQの物理隔離用: 環境変数 appVersion を注入)
    taskDefinition.addContainer('Container', {
      containerName: `${targetContainer}-container`,
      image: ecs.ContainerImage.fromEcrRepository(repository, applicationDockerImageTag),
      portMappings: [{ containerPort: 8080 }],
      logging: ecs.LogDriver.awsLogs({ logGroup, streamPrefix: 'ecs' }),
      environment: containerEnvVars,
      cpu: +cpu,
      memoryLimitMiB: +memory,
    });

    // Blue/Green用 ターゲットグループ (上限32文字を考慮)
    const targetGroupBlue = new elb.ApplicationTargetGroup(this, 'TargetGroupBlue', {
      targetGroupName: `tg-blu-${pocPrefix}`.substring(0, 32),
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      vpc,
      healthCheck: { enabled: true, path: apiPath, interval: Duration.seconds(30), timeout: Duration.seconds(5), unhealthyThresholdCount: 2, healthyThresholdCount: 5 },
    });

    const targetGroupGreen = new elb.ApplicationTargetGroup(this, 'TargetGroupGreen', {
      targetGroupName: `tg-grn-${pocPrefix}`.substring(0, 32),
      protocol: elb.ApplicationProtocol.HTTP,
      port: 80,
      vpc,
      healthCheck: { enabled: true, path: apiPath, interval: Duration.seconds(30), timeout: Duration.seconds(5), unhealthyThresholdCount: 2, healthyThresholdCount: 5 },
    });

    // ECS サービス定義 (サービス名固定化、ネイティブBlue/Greenコントローラ指定)
    const healthCheckGracePeriod = (targetContainer === 'cmpf_splitter') || (targetContainer === 'cmpf_service') ? 400 : 300;
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: `${targetContainer}-${pocPrefix}-svc`,
      cluster,
      taskDefinition,
      desiredCount: ecsTaskDesireCount,
      vpcSubnets: { subnets: envConfig.ECSService.Subnets.map((id, index) => ec2.Subnet.fromSubnetId(this, `Subnet${index}`, id)) },
      securityGroups: envConfig.ECSService.SecurityGroups.map((id, index) =>
        ec2.SecurityGroup.fromSecurityGroupId(this, `SecurityGroup${index}`, id)
      ),
      healthCheckGracePeriod: Duration.seconds(healthCheckGracePeriod),
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      minHealthyPercent: 100,
      deploymentController: { type: ecs.DeploymentControllerType.ECS },
    });

    // 初期状態としてBlue側にサービスを紐付け
    targetGroupBlue.addTarget(service);

    // Escape Hatchを利用して最新のBlue/Green戦略・ロールバック設定を明示的に注入
    const cfnService = service.node.defaultChild as ecs.CfnService;
    cfnService.addPropertyOverride('DeploymentConfiguration', {
      DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      Strategy: 'BLUE_GREEN',
    });

    // ALB リスナーの参照
    const sg = ec2.SecurityGroup.fromSecurityGroupId(this, 'SecurityGroup', envConfig.AlbSecurityGroupId);
    const listener = elb.ApplicationListener.fromApplicationListenerAttributes(this, 'Listener', {
      listenerArn: envConfig.AlbListenerArn,
      securityGroup: sg,
    });

    // リスナールール設定 (初期トラフィック: Blue 100%, Green 0%)
    const listenerRule = new elb.ApplicationListenerRule(this, 'ListenerRule', {
      listener,
      priority: albListenerRulePriority,
      conditions: [elb.ListenerCondition.pathPatterns([`${apiPath}*`])],
      action: elb.ListenerAction.forward([
        { targetGroup: targetGroupBlue, weight: 100 },
        { targetGroup: targetGroupGreen, weight: 0 }
      ]),
    });

    // ステータスドリフト対策: 以降のデプロイでトラフィック制御(Actions)をCloudFormationの管理から除外(ECSへ委譲)
    const cfnListenerRule = listenerRule.node.defaultChild as elb.CfnListenerRule;
    cfnListenerRule.addPropertyDeletionOverride('Actions');

    // CloudWatch Logs メトリクスフィルター
    metricFilterProps.forEach((props, index) => {
      new logs.MetricFilter(this, `MetricFilter${index}`, { ...props, logGroup });
    });
  }
}
