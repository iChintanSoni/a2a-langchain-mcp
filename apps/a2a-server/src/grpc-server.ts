/**
 * gRPC server for the A2A agent.
 *
 * Binds the A2A gRPC service to the configured host/port using insecure
 * credentials. All request handling logic lives in the SDK's
 * DefaultRequestHandler; this file is only concerned with gRPC wiring.
 */

import { Server, ServerCredentials } from "@grpc/grpc-js";
import { type DefaultRequestHandler } from "@a2a-js/sdk/server";
import { grpcService, A2AService, UserBuilder } from "@a2a-js/sdk/server/grpc";
import { ENV } from "#src/env.ts";

export function startGrpcServer(requestHandler: DefaultRequestHandler): void {
  const server = new Server();

  server.addService(
    A2AService,
    grpcService({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
  );

  server.bindAsync(
    `${ENV.HOST}:${ENV.GRPC_PORT}`,
    ServerCredentials.createInsecure(),
    () => {
      console.log(`🚀 gRPC server  ${ENV.HOST}:${ENV.GRPC_PORT}`);
    },
  );
}
