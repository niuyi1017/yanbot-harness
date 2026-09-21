import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { AdmissionService } from './admission/admission.service.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AccessTokenGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { ProductionHttpsMiddleware, RequestContextMiddleware } from './common/request-context.js';
import type { CloudConfig } from './config.js';
import { ControlPlaneController } from './control-plane/control-plane.controller.js';
import { ControlPlaneService } from './control-plane/control-plane.service.js';
import { ExecutionGrantController } from './execution-grants/execution-grant.controller.js';
import { ExecutionGrantService } from './execution-grants/execution-grant.service.js';
import { HealthController } from './health.controller.js';
import { DispatchService } from './dispatch/dispatch.service.js';
import { CONTROL_PLANE_STORE } from './persistence/control-plane.store.js';
import { CLOUD_CONFIG, MongoService } from './persistence/mongo.service.js';
import { MongoControlPlaneStore } from './persistence/mongo.store.js';
import { WorkspaceController } from './workspaces/workspace.controller.js';
import { WorkspaceService } from './workspaces/workspace.service.js';

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: CloudConfig) {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        WorkspaceController,
        ControlPlaneController,
        ExecutionGrantController,
      ],
      providers: [
        { provide: CLOUD_CONFIG, useValue: config },
        MongoService,
        MongoControlPlaneStore,
        { provide: CONTROL_PLANE_STORE, useExisting: MongoControlPlaneStore },
        AuthService,
        AuditService,
        AdmissionService,
        AccessTokenGuard,
        WorkspaceService,
        ControlPlaneService,
        ExecutionGrantService,
        DispatchService,
        ProductionHttpsMiddleware,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, ProductionHttpsMiddleware).forRoutes('*');
  }
}
