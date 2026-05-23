/**
 * @module orchestration/coding/multi-service
 * Multi-Service Orchestration — Section 7.2 of the system spec.
 *
 * Coordinates coding changes across multiple services/repositories when a task
 * spans service boundaries (e.g. adding a shared API field that requires changes
 * in both a backend service and a frontend consumer).
 *
 * Execution model:
 *  1. Each service gets its own CodingOrchestrator instance.
 *  2. A meta-orchestrator coordinates ordering and API contract validation.
 *  3. Shared types/interfaces are extracted and distributed to all services.
 *  4. Cross-service integration tests run after all services complete.
 *  5. PRs are created atomically (all-or-nothing across services).
 */

import type { ImplementerOutput } from './coding-types.js';

// ── ServiceSpec ───────────────────────────────────────────────────────────────

/**
 * Describes a single service/repository involved in a multi-service task.
 * Each ServiceSpec maps to one CodingOrchestrator instance.
 */
export interface ServiceSpec {
  /** Unique logical name for this service (e.g. 'backend-api', 'frontend'). */
  name: string;
  /** Git remote URL for cloning (e.g. 'github.com/org/service-a'). */
  repoUrl: string;
  /** Branch to check out and modify (agent branch will be created from this). */
  branch: string;
  /** Absolute path to the local workspace directory for this service. */
  workspaceDir: string;
  /** The specific coding task for this service (sub-task of the overall task). */
  codingTask: string;
  /**
   * Optional list of ServiceSpec names this service must wait for before
   * executing. Drives sequential vs. parallel change ordering.
   */
  dependsOn?: string[];
}

// ── APIContract ───────────────────────────────────────────────────────────────

/**
 * Describes a shared API contract between two services.
 * Contracts are validated after all services complete to detect breaking changes
 * or mismatches between provider implementation and consumer expectations.
 */
export interface APIContract {
  /** Logical service name that provides/implements the contract. */
  provider: string;
  /** Logical service name that consumes/depends on the contract. */
  consumer: string;
  /**
   * Path to the contract definition file (relative to provider workspaceDir).
   * May be an OpenAPI spec, GraphQL schema, gRPC .proto, or TypeScript types.
   */
  contractPath: string;
  /** Semantic version of the contract (e.g. '1.2.0'). */
  version: string;
  /** Type of the contract definition. */
  contractType: 'openapi' | 'graphql' | 'grpc' | 'typescript' | 'json-schema';
}

// ── MultiServiceTask ──────────────────────────────────────────────────────────

/**
 * Top-level descriptor for a task that spans multiple services/repos.
 * Consumed by the multi-service meta-orchestrator.
 */
export interface MultiServiceTask {
  /** Human-readable name for this multi-service task. */
  name: string;
  /** The overall task description (context for all service sub-tasks). */
  description: string;
  /** The services involved and their individual coding tasks. */
  services: ServiceSpec[];
  /** API contracts that must remain valid after all changes are applied. */
  apiContracts: APIContract[];
  /**
   * Whether service changes should be applied in parallel or sequentially.
   * 'sequential' honours ServiceSpec.dependsOn ordering.
   * 'parallel' ignores dependencies and runs all services simultaneously.
   */
  changeOrdering: 'parallel' | 'sequential';
  /**
   * Integration test commands to run after all services complete.
   * Executed in the context of the first service's workspace by default.
   */
  crossServiceTests: string[];
  /** Whether to create PRs atomically (all-or-nothing). Default: true. */
  atomicPRCreation: boolean;
}

// ── Task Artifact ─────────────────────────────────────────────────────────────

/**
 * The result produced for a single service after its coding session completes.
 * Collected by the meta-orchestrator for contract validation and PR creation.
 */
export interface TaskArtifact {
  /** Logical service name (matches ServiceSpec.name). */
  serviceId: string;
  /** The implementer's output for this service. */
  implementerOutput: ImplementerOutput;
  /** Extracted type definitions from this service (for contract validation). */
  exportedTypes?: TypeDefinition[];
  /** PR URL created for this service (populated after createPullRequest()). */
  prUrl?: string;
  /** Whether this service's coding session succeeded. */
  success: boolean;
  /** Error message if the session failed. */
  errorMessage?: string;
}

/** A single named type/interface exported by a service. */
export interface TypeDefinition {
  /** Fully-qualified type name (e.g. 'UserResponse'). */
  name: string;
  /** Source file where the type is defined (relative path). */
  sourceFile: string;
  /** TypeScript or JSON-schema representation of the type. */
  definition: string;
}

// ── ContractViolation ─────────────────────────────────────────────────────────

/**
 * A mismatch detected between a provider's implementation and a consumer's
 * expectations, as specified in an APIContract.
 */
export interface ContractViolation {
  /** The contract that was violated. */
  contract: APIContract;
  /** Human-readable description of the violation. */
  description: string;
  /** Whether this is a breaking change that would prevent deployment. */
  severity: 'breaking' | 'warning';
  /** File and line reference for the violation location (optional). */
  location?: string;
  /** Provider type that mismatches. */
  providerType?: TypeDefinition;
  /** Consumer expectation that was not met. */
  consumerExpectation?: TypeDefinition;
}

// ── Contract Validation ───────────────────────────────────────────────────────

/**
 * Extract type definitions from a service's task artifact.
 * Real implementation would parse TypeScript AST or OpenAPI schema; this
 * version provides the structural contract used by validateAPIContracts().
 */
function extractTypes(artifact: TaskArtifact | undefined): TypeDefinition[] {
  if (!artifact) return [];
  return artifact.exportedTypes ?? [];
}

/**
 * Compare provider type definitions against consumer type expectations.
 * Returns violations where the types do not match.
 *
 * This is a structural comparison: each consumer-expected type must have a
 * corresponding provider definition with the same name and compatible shape.
 */
function compareTypes(
  providerTypes: TypeDefinition[],
  consumerExpectations: TypeDefinition[],
  contract: APIContract,
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const providerMap = new Map(providerTypes.map((t) => [t.name, t]));

  for (const expected of consumerExpectations) {
    const provided = providerMap.get(expected.name);
    if (!provided) {
      violations.push({
        contract,
        description: `Consumer expects type '${expected.name}' from provider '${contract.provider}', but it was not found in provider exports.`,
        severity: 'breaking',
        consumerExpectation: expected,
      });
      continue;
    }
    // Surface-level check: definitions must be non-empty and names must match.
    // A full implementation would deep-compare the AST / JSON schema.
    if (provided.definition.trim() === '') {
      violations.push({
        contract,
        description: `Provider type '${expected.name}' is exported but has an empty definition.`,
        severity: 'warning',
        providerType: provided,
        consumerExpectation: expected,
      });
    }
  }

  return violations;
}

/**
 * Validate all API contracts after all service coding sessions complete.
 * For each contract, checks that the provider's exported types satisfy the
 * consumer's expectations.
 *
 * @param contracts      List of APIContracts from the MultiServiceTask.
 * @param serviceResults Map from service name → TaskArtifact for each service.
 * @returns Array of ContractViolation (empty = all contracts satisfied).
 */
export async function validateAPIContracts(
  contracts: APIContract[],
  serviceResults: Map<string, TaskArtifact>,
): Promise<ContractViolation[]> {
  const violations: ContractViolation[] = [];

  for (const contract of contracts) {
    const providerArtifact = serviceResults.get(contract.provider);
    const consumerArtifact = serviceResults.get(contract.consumer);

    if (!providerArtifact) {
      violations.push({
        contract,
        description: `Provider service '${contract.provider}' has no task artifact — coding session may not have run.`,
        severity: 'breaking',
      });
      continue;
    }

    if (!consumerArtifact) {
      violations.push({
        contract,
        description: `Consumer service '${contract.consumer}' has no task artifact — coding session may not have run.`,
        severity: 'warning',
      });
      continue;
    }

    const providerTypes = extractTypes(providerArtifact);
    const consumerExpectations = extractTypes(consumerArtifact);
    const mismatches = compareTypes(providerTypes, consumerExpectations, contract);
    violations.push(...mismatches);
  }

  return violations;
}

// ── Multi-service execution plan ─────────────────────────────────────────────

/**
 * Build an ordered execution plan from a MultiServiceTask.
 * When changeOrdering='sequential', services are topologically sorted based on
 * ServiceSpec.dependsOn. When 'parallel', all services are in a single layer.
 *
 * @returns Array of layers, where each layer is an array of services that can
 *          execute concurrently.
 */
export function buildExecutionPlan(task: MultiServiceTask): ServiceSpec[][] {
  if (task.changeOrdering === 'parallel') {
    return [task.services];
  }

  // Topological sort (Kahn's algorithm)
  const serviceMap = new Map(task.services.map((s) => [s.name, s]));
  const inDegree = new Map(task.services.map((s) => [s.name, 0]));
  const dependents = new Map<string, string[]>(
    task.services.map((s) => [s.name, []]),
  );

  for (const svc of task.services) {
    for (const dep of svc.dependsOn ?? []) {
      inDegree.set(svc.name, (inDegree.get(svc.name) ?? 0) + 1);
      dependents.get(dep)?.push(svc.name);
    }
  }

  const layers: ServiceSpec[][] = [];
  let frontier = task.services.filter((s) => (inDegree.get(s.name) ?? 0) === 0);

  while (frontier.length > 0) {
    layers.push(frontier);
    const next: ServiceSpec[] = [];
    for (const svc of frontier) {
      for (const depName of dependents.get(svc.name) ?? []) {
        const newDegree = (inDegree.get(depName) ?? 1) - 1;
        inDegree.set(depName, newDegree);
        if (newDegree === 0) {
          const dep = serviceMap.get(depName);
          if (dep) next.push(dep);
        }
      }
    }
    frontier = next;
  }

  // Any services not placed have cyclic dependencies — append them as a final layer
  const placed = new Set(layers.flat().map((s) => s.name));
  const remaining = task.services.filter((s) => !placed.has(s.name));
  if (remaining.length > 0) {
    layers.push(remaining);
  }

  return layers;
}
