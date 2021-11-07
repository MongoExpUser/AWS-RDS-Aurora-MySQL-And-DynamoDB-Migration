[![CI - AWS-TS-CDK Migration](https://github.com/MongoExpUser/AWS-RDS-Aurora-MySQL-And-DynamoDB-Migration/actions/workflows/aws-migration-cdk.yml/badge.svg)](https://github.com/MongoExpUser/AWS-RDS-Aurora-MySQL-And-DynamoDB-Migration/actions/workflows/aws-migration-cdk.yml)

# AWS-RDS-Aurora-MySQL-And-DynamoDB-Migration

<br>
<strong>
Create AWS RDS Aurora MySQL DB Cluster, AWS DynamoDB and Related Resources for a Migration Project, with AWS TypeScript CDK
</strong>
<br><br>
The  STACK deploys the following specific resources:

1) AWS VPC.

2) AWS VPC-related resources.

3) AWS DynamoDB Table.

4) AWS Secret Manager's Secret (username and password), for the DB Cluster.

5) AWS RDS Aurora (MySQL-compatible) DB Cluster.

6) AWS S3 Buckets used, for Import and Export, by AWS RDS Aurora (MySQL-compatible) DB Cluster.

## DEPLOYING THE CDK STACK

1) To deploy the stack  on <strong>```AWS```</strong> via <strong>Local Computer</strong>, follow the steps in the following link:<br>
<strong><a href="https://docs.aws.amazon.com/cdk/latest/guide/work-with-cdk-typescript.html" rel="nofollow"> Working with the AWS CDK in TypeScript</a></p></strong>
 
 
2) To deploy the stack  on <strong>```AWS```</strong> via <strong>GitHub Actions</strong> see the following link: <br>
 <strong><a href="https://github.com/MongoExpUser/AWS-RDS-Aurora-MySQL-And-DynamoDB-Migration/blob/main/.github/workflows/aws-migration-cdk.yml" rel="nofollow">CI: AWS-TS-CDK Migration</a></p></strong>
  

# License

Copyright © 2015 - present. MongoExpUser

Licensed under the MIT license.
