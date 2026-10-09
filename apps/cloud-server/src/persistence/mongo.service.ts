import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import mongoose, { type Connection, type Model } from 'mongoose';

import type { CloudConfig } from '../config.js';
import { modelDefinitions } from './schemas.js';

export const CLOUD_CONFIG = Symbol('CLOUD_CONFIG');

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  #connection: Connection | undefined;
  readonly #config: CloudConfig;

  constructor(@Inject(CLOUD_CONFIG) config: CloudConfig) {
    this.#config = config;
  }

  async onModuleInit(): Promise<void> {
    const connection = mongoose.createConnection(this.#config.mongodbUri, {
      dbName: this.#config.mongodbDatabase,
      autoIndex: this.#config.nodeEnv !== 'production',
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();
    if (this.#config.nodeEnv === 'production') {
      try {
        const hello = await connection.db!.admin().command({ hello: 1 });
        if (!hello.setName) throw new Error('Replica set unavailable.');
      } catch {
        await connection.close();
        throw new Error('Production Mongo must provide a reachable replica set.');
      }
    }
    for (const [name, schema, collection] of modelDefinitions) connection.model(name, schema, collection);
    this.#connection = connection;
  }

  model<T>(name: string): Model<T> {
    if (!this.#connection) throw new Error('MongoDB is not connected.');
    return this.#connection.model<T>(name);
  }

  async transaction<T>(operation: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
    if (!this.#connection) throw new Error('MongoDB is not connected.');
    const session = await this.#connection.startSession();
    try {
      return await session.withTransaction(() => operation(session));
    } finally {
      await session.endSession();
    }
  }

  async syncIndexes(): Promise<void> {
    if (!this.#connection) throw new Error('MongoDB is not connected.');
    // Keep uniqueness enforced throughout the explicit legacy-index migration.
    const runs = this.#connection.model('HarnessRun').collection;
    await runs.createIndex(
      { organizationId: 1, sessionId: 1, idempotencyKey: 1 },
      {
        name: 'run_idempotency_present',
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
    );
    const legacy = (await runs.indexes()).find(
      (index) => index.name === 'organizationId_1_sessionId_1_idempotencyKey_1',
    );
    if (legacy) {
      if (
        !legacy.unique ||
        !legacy.sparse ||
        legacy.partialFilterExpression ||
        JSON.stringify(legacy.key) !== JSON.stringify({ organizationId: 1, sessionId: 1, idempotencyKey: 1 })
      )
        throw new Error('The legacy Run index differs from the expected migration source.');
      await runs.dropIndex(legacy.name!);
    }
    for (const [name] of modelDefinitions) await this.#connection.model(name).syncIndexes();
  }

  async onModuleDestroy(): Promise<void> {
    await this.#connection?.close();
    this.#connection = undefined;
  }
}
