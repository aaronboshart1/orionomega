# Hindsight API Discovery Report

## Summary
Successfully discovered a fully operational Hindsight instance at **10.0.0.13** with comprehensive API and web interfaces.

## Discovered Services

### 1. Hindsight HTTP API - Port 8888
- **Base URL**: `http://10.0.0.13:8888`
- **API Version**: 0.4.13
- **Status**: ✅ Healthy - Database Connected
- **Documentation**: Swagger UI available at `/docs`
- **OpenAPI Spec**: Available at `/openapi.json`

#### Key API Endpoints:

**Monitoring:**
- `GET /health` - Health check endpoint
- `GET /version` - API version and feature flags
- `GET /metrics` - Prometheus metrics

**Memory Management:**
- `GET /v1/default/banks` - List available memory banks
- `GET /v1/default/banks/{bank_id}/memories/list` - List memory units (supports pagination, search, type filtering)
- `GET /v1/default/banks/{bank_id}/graph` - Get memory graph data for visualization
- Memory types supported: `world`, `experience`, `opinion`

**Features Enabled:**
- ✅ observations
- ✅ mcp (Model Context Protocol)
- ✅ worker
- ✅ file_upload_api
- ❌ bank_config_api

### 2. Hindsight Control Plane - Port 9999
- **Base URL**: `http://10.0.0.13:9999`
- **Type**: Next.js Web Application
- **Title**: "Hindsight Control Plane"
- **Description**: Control plane for the temporal semantic memory system
- **Dashboard**: Available at `/dashboard`

### 3. File Server - Port 8899
- **Base URL**: `http://10.0.0.13:8899`
- **Type**: HTTP directory listing server
- **Content**: Complete Hindsight project source code and development files
- **Notable directories**: `hindsight/`, `hindsight-api/`, `hindsight-cli/`, `hindsight-docs/`

### 4. VNC Service - Port 5901
- **Service**: VNC remote desktop (vnc-1)
- **Status**: Open but not tested

## Available Memory Banks

The system contains **8 active memory banks**:

1. **project-omegaclaw** - OmegaClaw Project architecture and implementation
2. **jarvis-core** - Personal AI assistant memory for Aaron Boshart
3. **infra** - Infrastructure memory for homelab and systems
4. **project-dispensary-scraper** - Dispensary scraper project
5. **project-orionclaw-ui** - OrionClaw UI project  
6. **project-orionclaw** - OrionClaw project
7. **project-mediacast** - MediaCast project
8. **project-getcanna** - GetCanna project technical memory

## Personality and History Data

✅ **Successfully accessed personality and history data:**

- **Experience memories**: Contains user preferences and behavioral patterns
  - Example: "Aaron prefers agent should delegate all task work through Orion to keep main agent free for conversation"
  - Example: "Aaron wants execution only when user explicitly says 'do it', 'build it', or 'go ahead'"
  
- **World memories**: Contains factual information and system configurations
  - Example: "OrionOmega system deployed with VM at 10.0.0.42, Tailscale at 100.87.236.42"

- **Total memories**: Over 1,600 memory units in jarvis-core bank alone

## Authentication

- **Authentication**: Optional - APIs work without authentication
- **Authorization header**: Accepted but not required for basic read operations
- **Security**: Appears to be internal/development deployment

## API Capabilities

**Read Operations (Confirmed Working):**
- ✅ List memory banks
- ✅ List memories with filtering (by type, search query)
- ✅ Get health status and version info
- ✅ Retrieve graph data for visualization
- ✅ Access personality data (experience type memories)
- ✅ Access historical data (world type memories)

**Write Operations:**
- Methods available per OpenAPI spec but not tested for authentication requirements

## Technical Details

- **Database**: Connected and operational
- **API Framework**: FastAPI with OpenAPI 3.1.0
- **Web Framework**: Next.js for control plane
- **Memory Types**: Categorized as world, experience, and opinion facts
- **Search**: Full-text search capabilities available
- **Visualization**: Graph-based memory relationship visualization

## Conclusion

The Hindsight instance at 10.0.0.13 is fully operational with comprehensive API access to personality data, history, and memory management capabilities. The system provides both programmatic API access and web-based control plane interfaces.