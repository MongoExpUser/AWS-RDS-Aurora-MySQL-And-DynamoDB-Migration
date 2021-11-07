/*
 ******************************************************************************************************************
 *                                                                                                                *
 * @License Starts                                                                                                *
 *                                                                                                                *
 * Copyright © 2015 - present. MongoExpuser. All Rights Reserved.                                                 *
 *                                                                                                                *
 * License: MIT - https://github.com/MongoExpUser/AWS-RDS-MySQL-Migration/blob/main/LICENSE.                      *
 *                                                                                                                *
 * @License Ends                                                                                                  *
 **************************************************************************************************************** *
 *                                                                                                                *
 *  Database Migration Project.                                                                                   *
 *                                                                                                                *
 *  cdk-migration-stack.ts implements a STACK for the deployment of resources for Database Migration, including:  *
 *                                                                                                                *
 *  1) AWS VPC and related resources                                                                              *
 *                                                                                                                *
 *  2) AWS Secret Manager's Secret (username and password), for the Cluster DB                                    *
 *                                                                                                                *
 *  3) AWS RDS Aurora (MySQL-compatible)  DB Cluster.                                                             *
 *                                                                                                                *
 *  4) AWS S3 Buckets used, for Import and Export, by  DB Cluster                                                 *
 *                                                                                                                *
 ******************************************************************************************************************
*/


import { Secret } from '@aws-cdk/aws-secretsmanager';
import { User, PolicyStatement, PolicyStatementProps, ServicePrincipal } from '@aws-cdk/aws-iam';
import { App, CfnOutput, Construct, Duration, Stack, StackProps, RemovalPolicy, Fn} from '@aws-cdk/core';
import { Bucket, BucketPolicy, BlockPublicAccess, BucketEncryption, BucketAccessControl } from '@aws-cdk/aws-s3';
import { Vpc, SubnetType, SecurityGroup, InstanceClass, InstanceType, InstanceSize, Subnet, Port, Peer} from '@aws-cdk/aws-ec2';
import { CfnDBCluster, CfnDBSubnetGroup, DatabaseClusterEngine, DatabaseCluster, Credentials,AuroraPostgresEngineVersion, AuroraMysqlEngineVersion,
          ParameterGroup, } from '@aws-cdk/aws-rds';


export class ResourcesCreationStack extends Stack{
  param: any;
  account: any;
  region: string;
  credentials: any;
  namePrefix: string;
  concatenatedSecretName: string;
  secretArn: string;

  constructor(scope: App, id: string, props: StackProps, inputParametersObj:any) {
    super(scope, id, props);
    this.param = inputParametersObj;
    this.account = this.param.env.account;
    this.region = this.param.env.region;
    this.namePrefix = `${this.param.orgName}-${this.param.projectName}-${this.param.environment}-${this.param.regionName}`;
    this.concatenatedSecretName = `${this.namePrefix}-${this.param.secretName}`;
    this.secretArn = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${this.concatenatedSecretName}`;
    
    // 1. Create vpc and all vpc-related resoources, to be used in creating other resources
    // a. create vpc with vpc-subnets
    // note 1: One NAT gateway/instance per Availability Zone, is created by default when public subet is created
    // note 2: the default route is setup for public subnet, so set natGateways to zero (0) if not needed
    const publicSubnet  = "public";
    const privateSubnet = "private";
    const isolatedSubnet  = "isolated";
    const vpc = new Vpc(this, "Vpc", {
      cidr: "10.0.0.0/16",
      natGateways: 0,
      vpnGateway: false,
      subnetConfiguration: [
        {cidrMask: 24, name: publicSubnet, subnetType: SubnetType.PUBLIC},
        {cidrMask: 28, name: isolatedSubnet, subnetType: SubnetType.ISOLATED},
        //If natGateways=0, then don't configure any PRIVATE subnets, so comment out
        //{cidrMask: 24, name: privateSubnet, subnetType: SubnetType.PRIVATE},
      ]
    });
    
    // b. create security group that allow incoming traffic on ports: 22 and this.param.port (i.e. db cluster port for access)
    // i. create the vpc-sgs
    const vpcOutBoundDescription = "Outbound: Allow SSH Access to EC2 instances"
    const sshIngressRuleDescription = "Ingress Rule: Allow SSH Access From Outside";
    const specifiedPortIngressRuleDescription = "Ingress Rule: Allow Access to Specified Port Access From Outside"
    const vpcSecurityGroup = new SecurityGroup(this, "VpcSecurityGroup", {
      vpc: vpc,
      securityGroupName : `${this.param.preOrPostFix}-vpc-sg`,
      description: vpcOutBoundDescription,
      allowAllOutbound: true
    });
    //ii. allow into the port (22)
    vpcSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(22),
      sshIngressRuleDescription
    );
    //iii. allow into the port (db port)
    vpcSecurityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(Number(this.param.port)),
      specifiedPortIngressRuleDescription
    );
    
    // 2a. Create secret (username and password), for AWS RDS Aurora DB Cluster, with AWS Secret Manager
    const auroraDBClusterSecret = new Secret(this, "AuroraDBClusterSecret", {
      description: this.param.secretDescription,
      secretName: this.concatenatedSecretName,
      generateSecretString: {
        excludeCharacters: this.param.excludeCharacters,
        excludePunctuation: this.param.excludePunctuation,
        generateStringKey: this.param.generateStringKey,
        passwordLength: this.param.passwordLength,
        requireEachIncludedType: this.param.requireEachIncludedType,
        secretStringTemplate: this.param.secretStringTemplate
      }
    });
    
    // 2b. Get and pass in secret's username and password to be used as credentials for the AWS RDS Aurora DB Cluster
    const getSecret = Secret.fromSecretName(this, "ReferencedAuroraDBClusterSecret", this.concatenatedSecretName);
    this.credentials = {
      masterUsername : getSecret.secretValueFromJson("username"),
      masterUserPassword : getSecret.secretValueFromJson("password")
    };
    
    // 3 Create S3 buckets (import and export) for the non-serverless Aurora Cluster
    const bucketList = [];
    const bucketNames = [`${this.namePrefix}-${this.param.importBucketName}`, `${this.namePrefix}-${this.param.exportBucketName}`];
    const bucketNamesWithoutPrefix = [`${this.param.importBucketName}`, `${this.param.exportBucketName}`];
    const bucketNumber =  bucketNames.length;
    
    //create bucket and bucket policies in a loop
    for(let index = 0;  index < bucketNumber; index++)
    {
      //a. create bucket
      const bucket = new Bucket(this, bucketNamesWithoutPrefix[index] + "Bucket", {
          versioned: false,
          removalPolicy: RemovalPolicy.DESTROY,
          accessControl: BucketAccessControl.PRIVATE,
          publicReadAccess: false,
          bucketName: bucketNames[index],
          encryption: BucketEncryption.S3_MANAGED,
          blockPublicAccess: new BlockPublicAccess ({
            blockPublicAcls: true,
            blockPublicPolicy: true,
            ignorePublicAcls: true,
            restrictPublicBuckets: true
          })
      });
      
      // b. Create relevent policy statements and add to the bucket's Document Policy
      // i. statement 1
      const AWSECSS3ConsoleBucketRead = new PolicyStatement({
          sid: "AWSECSS3ConsoleBucketRead",
          principals: [new ServicePrincipal("ecs.amazonaws.com"), new ServicePrincipal("rds.amazonaws.com")],
          actions: ["s3:GetBucketAcl", "s3:GetBucketLocation", "s3:ListBucket"],
          resources: [`arn:aws:s3:::${bucketNames[index]}`]
      });
      // ii. statement 2
      const AWSECSS3BucketObjectRead = new PolicyStatement({
          sid: "AWSECSS3BucketObjectRead",
          principals: [new ServicePrincipal("ecs.amazonaws.com"), new ServicePrincipal("rds.amazonaws.com")],
          actions: ["s3:GetObject", "s3:GetObjectAcl", "s3:GetObjectVersion", "s3:GetObjectTagging"],
          resources: [`arn:aws:s3:::${bucketNames[index]}`, `arn:aws:s3:::${bucketNames[index]}/*`]
      });
      // iii. statement 3
      const AWSECSS3PutObject = new PolicyStatement({
          sid: "AWSECSS3PutObject",
          principals: [new ServicePrincipal("ecs.amazonaws.com"), new ServicePrincipal("rds.amazonaws.com")],
          actions: ["s3:PutObject"],
          resources: [`arn:aws:s3:::${bucketNames[index]}`, `arn:aws:s3:::${bucketNames[index]}/*`]
      });
      // iv. add condition to statement 3
      AWSECSS3PutObject.addCondition("StringEquals", {
        "s3:x-amz-acl": ["bucket-owner-full-control"]
      });
      // v. finally add all statement to the bucket policy statements
      bucket.addToResourcePolicy(AWSECSS3ConsoleBucketRead);
      bucket.addToResourcePolicy(AWSECSS3BucketObjectRead);
      bucket.addToResourcePolicy(AWSECSS3PutObject);
      
      //c. append buckets to the bucket list/array for later referencing
      if(index === 0)
      {
        bucketList.push(bucket); //import bucket
      }
      if(index === 1)
      {
         bucketList.push(bucket); //export bucket
      }
    }
    
    // 4. Create the AWS RDS Aurora DB Cluster (non-serverless)
    const auroraDBCluster = new DatabaseCluster(this, "AuroraDBCluster", {
      clusterIdentifier: `${this.namePrefix}-${this.param.dbClusterIdentifier}`,
      defaultDatabaseName: this.param.databaseName,
      instanceIdentifierBase: `${this.namePrefix}-${this.param.dbClusterIdentifier}-`,
      deletionProtection : this.param.deletionProtection,
      engine: DatabaseClusterEngine.auroraMysql({ version: AuroraMysqlEngineVersion.VER_5_7_12}),
      instances: this.param.maxCapacity,
      storageEncrypted: this.param.storageEncrypted,
      cloudwatchLogsExports: this.param.cloudwatchLogsExports,
      monitoringInterval: Duration.seconds(this.param.monitoringInterval),
      removalPolicy: RemovalPolicy.DESTROY,
      preferredMaintenanceWindow: this.param.preferredMaintenanceWindow,
      backup: {
        preferredWindow: this.param.preferredBackupWindow,
        retention: Duration.days(this.param.backupRetentionPeriod)
      },
      credentials: {
        username: this.credentials.masterUsername,
        password: this.credentials.masterUserPassword
      },
      instanceProps: {
        vpc,
        allowMajorVersionUpgrade: true,
        autoMinorVersionUpgrade: true,
        deleteAutomatedBackups: true,
        // Other Classes: MEMORY3, MEMORY4, MEMORY5, etc. Other Sizes: LARGE, XLRAGE, XLARGE2, etc
        instanceType:   InstanceType.of(InstanceClass.BURSTABLE3,  InstanceSize.MEDIUM),
        // Performance Insights is not supported for the instance class and size (t3.medium), so disable
        enablePerformanceInsights: false,
        securityGroups: [vpcSecurityGroup],
        vpcSubnets: vpc.selectSubnets({subnetType: SubnetType.ISOLATED}),
        // Use default or already created parameter group of specified "dbClusterParameterGroupName"
        parameterGroup: ParameterGroup.fromParameterGroupName(this, "AuroraMySQLInstanceParameterGroup", this.param.dbInstanceParameterGroupName)
      },
      s3ImportBuckets: [bucketList[0]],
      s3ExportBuckets: [bucketList[1]],
      parameterGroup: ParameterGroup.fromParameterGroupName(this, "AuroraMySQLClusterParameterGroup", this.param.dbClusterParameterGroupName)
    });
  
    
    // 5. specify dependencies: create vpc, security grp, buckets, and secret
    //    before creating DB Cluster and create vpc before creating  security grp
    vpcSecurityGroup.node.addDependency(vpc);
    auroraDBCluster.node.addDependency(vpc);
    auroraDBCluster.node.addDependency(vpcSecurityGroup);
    auroraDBCluster.node.addDependency(bucketList[0]);
    auroraDBCluster.node.addDependency(bucketList[1]);
    auroraDBCluster.node.addDependency(auroraDBClusterSecret);
    
    
    // 6. Create outputs: Aurora Vpc, Aurora Secret, Aurora DB Cluster, S3 Bucket and S3 Bucket policy
    // a. vpc and related resources
    // a(i). output vpc
    new CfnOutput(this, "VpcOutput", {
      exportName: "Vpc",
      value: String(vpc.vpcId),
      description: this.param.vpcDescription
    });
    // a(ii). output security group
    new CfnOutput(this, "VpcSecurityGroupOutput", {
      exportName:  "VpcSecurityGroup",
      value:  String(vpcSecurityGroup.securityGroupName),
      description: this.param.vpcSecurityGroupDescription
    });
    
    // b. output secret
    new CfnOutput(this, "AuroraDBClusterSecretBOutput",
    {
      exportName: "AuroraDBClusterSecretBOutput",
      value: String(this.secretArn),
      description: this.param.secretDescription
    });
    
    // c. output DB Cluster
    new CfnOutput(this, "AuroraDBClusterOutput", {
      exportName: "AuroraDBClusterOutput",
      value: String(`arn:aws:rds:${this.region}:${this.account}:cluster:${this.namePrefix}-${this.param.dbClusterIdentifier}`),
      description: this.param.dbClusterDescription
    });
    
    // d. output S3 buckets and policies
    for(let index = 0;  index < bucketNumber; index++)
    {
      const bucketNameOutputWithFirstCapilalizesLetter = bucketNamesWithoutPrefix[index][0].toUpperCase() + bucketNamesWithoutPrefix[index].substr(1) + "BucketOutput"
      new CfnOutput(this, bucketNameOutputWithFirstCapilalizesLetter, {
        exportName: bucketNameOutputWithFirstCapilalizesLetter,
        value: String(`arn:aws:s3:::${bucketNames[index]}`)
      });
      const bucketPolicyNameOutputWithFirstCapilalizesLetter = bucketNamesWithoutPrefix[index][0].toUpperCase() + bucketNamesWithoutPrefix[index].substr(1) + "BucketPolicyOutput"
      new CfnOutput(this, bucketPolicyNameOutputWithFirstCapilalizesLetter, {
        exportName: bucketPolicyNameOutputWithFirstCapilalizesLetter,
        value: String(`arn:aws:iam::${this.account}:policy/${bucketNames[index]}-policy`)
      });
    }
  }
}


export class InvokeResourcesCreationStack {
  constructor(){

    // declare & define parameters, instantiate STACK and create resources

    // 1. declare and define input parameters
    // a. naming, tagginng and environmental parameters
    const orgName: string = "org";
    const projectName: string = "mgr";
    const environment: string = "dev";
    const regionName: string = "us-east-1";
    const preOrPostFix: string  = orgName + "-" + projectName;
    const tagKeyName: string = "name";
    const stackName: string = "mgr-stack";
    const stackId: string = "stack-" + orgName + "-01";
    const stackDescription: string = "Deploys Resources for Database Migration with TypeScript CDK.";
    const env = {
      "account" : process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
      "region" :  process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION
    };
    // b. secret (username and password) parameters
    const secretName: string = "secret";
    const secretDescription: string = "Dynamically generated secret - username and password";
    const excludeCharacters: string = String("@/'");
    const excludePunctuation: boolean = true;
    const generateStringKey: string = "password";
    const passwordLength: number = 30;
    const requireEachIncludedType: boolean = false;
    const secretStringTemplate: string = JSON.stringify({"username" : "db_admin" });
    // c. aurora database parameters
    const cloudwatchLogsExports: string[] = ["audit", "error", "general", "slowquery"];
    const databaseName: string = "testDB";
    const dbInstanceParameterGroupName: string =  "default.aurora-mysql5.7";
    const dbClusterParameterGroupName: string =  "default.aurora-mysql5.7";
    const dbClusterDescription: string = "The AWS RDS Aurora MySQL Cluster "  + preOrPostFix;
    const dbClusterParameterGroupDescription: string = "Parameter Group - Aurora MySQL Instance for " + preOrPostFix;
    const dbClusterIdentifier: string =  "db-server"
    const deletionProtection: boolean = true;
    const enableHttpEndpoint: boolean = true;
    const port: number = 3306;
    const autoPause: boolean = true;
    const maxCapacity: number = 2;
    const minCapacity: number = 2;
    const monitoringInterval: number = 60;
    const secondsUntilAutoPause: number = 36000;
    const preferredMaintenanceWindow: string =  "sun:11:05-sun:11:35";
    const preferredBackupWindow: string ="20:05-20:35";
    const backupRetentionPeriod: number = 1;
    const storageEncrypted: boolean = true;
    const vpcDescription: string  = "Vpc for " + preOrPostFix;
    const vpcSecurityGroupDescription: string  = "Vpc Security Group for " + preOrPostFix;
    const dbSubnetGroupDescription: string  = "DB Subnet Group for " + preOrPostFix;
    //d. S3 bucket parameters
    const importBucketName: string = "import";
    const exportBucketName: string = "export";
    
    // 2. create a new object and store input parameters in the object
    const inputParametersObj = {
      // i. naming, tagginng and environmental parameters
      "orgName" : orgName,
      "projectName" : projectName,
      "environment" : environment,
      "regionName" : regionName,
      "preOrPostFix" : preOrPostFix,
      "tagKeyName" : tagKeyName,
      "stackName" :  stackName,
      "stackId" :  stackId,
      "stackDescription" : stackDescription,
      "env" : env,
      // ii. secret (username and password) parameters
      "secretName" : secretName,
      "secretDescription": secretDescription,
      "excludeCharacters": excludeCharacters,
      "excludePunctuation": excludePunctuation,
      "generateStringKey": generateStringKey,
      "passwordLength": passwordLength,
      "requireEachIncludedType": requireEachIncludedType,
      "secretStringTemplate": secretStringTemplate,
      // iii. aurora database parameters
      "cloudwatchLogsExports" : cloudwatchLogsExports,
      "databaseName" : databaseName,
      //"dbInstanceParameterGroupName" : dbInstanceParameterGroupName,
      "dbClusterParameterGroupName" : dbClusterParameterGroupName,
      "dbClusterDescription" : dbClusterDescription,
      "dbClusterParameterGroupDescription" : dbClusterParameterGroupDescription,
      "dbClusterIdentifier" :  dbClusterIdentifier,
      "deletionProtection" : deletionProtection,
      "enableHttpEndpoint": enableHttpEndpoint,
      "port" :  port,
      "autoPause" : autoPause,
      "maxCapacity" : maxCapacity,
      "minCapacity": minCapacity,
      "monitoringInterval" : monitoringInterval,
      "secondsUntilAutoPause" : secondsUntilAutoPause,
      "preferredMaintenanceWindow": preferredMaintenanceWindow,
      "preferredBackupWindow": preferredBackupWindow,
      "backupRetentionPeriod": backupRetentionPeriod,
      "storageEncrypted": storageEncrypted,
      "vpcDescription" : vpcDescription,
      "vpcSecurityGroupDescription" : vpcSecurityGroupDescription,
      "dbSubnetGroupDescription" : dbSubnetGroupDescription,
      //iv. S3 bucket parameters
      "importBucketName" : importBucketName,
      "exportBucketName" : exportBucketName,
    }
    
    // 3 create props option object and store relevant STACK parameters (inclusding env) in the object
    const propsOptions: any = {
      env: env,
      stackId: stackId,
      stackName: stackName,
      description: stackDescription,
      terminationProtection: false,
      analyticsReporting: true
    }
    
    // 3. instantiate STACK; pass in stackId, propsOptions & inputParametersObj; to create resources
     const createResource = new ResourcesCreationStack(new App(), stackId, propsOptions, inputParametersObj);
  }
}


const createResources = new InvokeResourcesCreationStack();
