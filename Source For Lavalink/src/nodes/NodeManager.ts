/**
 * NodeManager - Singleton pattern for managing multiple Lavalink nodes
 * Implements penalty-based load balancing and automatic failover
 */

import { Node } from './Node';
import type { NodeOptions } from '../types/lavalink';
import type { LavalinkEventEmitter } from '../manager/events';

export type PenaltyCalculator = (node: Node) => number;

export class NodeManager {
  private static instance: NodeManager | null = null;

  private nodes: Map<string, Node> = new Map();
  private clientId: string | null = null;
  private eventEmitter: LavalinkEventEmitter | null = null;
  private customPenaltyCalculator: PenaltyCalculator | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckIntervalMs: number = 60000; // 1 minute

  private constructor() {}

  /**
   * Get the singleton instance
   */
  public static getInstance(): NodeManager {
    if (!NodeManager.instance) {
      NodeManager.instance = new NodeManager();
    }
    return NodeManager.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  public static resetInstance(): void {
    if (NodeManager.instance) {
      NodeManager.instance.disconnectAll();
      NodeManager.instance = null;
    }
  }

  /**
   * Initialize the node manager
   */
  public init(clientId: string, eventEmitter: LavalinkEventEmitter, healthCheckIntervalMs?: number): void {
    this.clientId = clientId;
    this.eventEmitter = eventEmitter;
    if (healthCheckIntervalMs && healthCheckIntervalMs > 0) {
      this.healthCheckIntervalMs = healthCheckIntervalMs;
    }
    this.startHealthCheck();
  }

  /**
   * Start periodic health check for all nodes
   */
  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckIntervalMs);
    
    if (this.healthCheckInterval.unref) {
      this.healthCheckInterval.unref();
    }
  }

  /**
   * Stop health check interval
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private healthCheckFailures: Map<string, number> = new Map();
  private readonly MAX_HEALTH_CHECK_FAILURES = 3; // Remove only after 3 failed checks

  /**
   * Perform health check on all nodes
   */
  public async performHealthCheck(): Promise<void> {
    const nodesToRemove: string[] = [];

    for (const [name, node] of this.nodes) {
      if (!node.isConnected()) {
        const failures = (this.healthCheckFailures.get(name) || 0) + 1;
        this.healthCheckFailures.set(name, failures);
        this.eventEmitter?.emit(
          'debug',
          `Health check: Node ${name} is not connected (failure ${failures}/${this.MAX_HEALTH_CHECK_FAILURES})`
        );
        if (failures >= this.MAX_HEALTH_CHECK_FAILURES) {
          nodesToRemove.push(name);
        }
      } else {
        try {
          await node.getStats();
          // Reset failures if node responds
          this.healthCheckFailures.delete(name);
        } catch (error) {
          const failures = (this.healthCheckFailures.get(name) || 0) + 1;
          this.healthCheckFailures.set(name, failures);
          this.eventEmitter?.emit(
            'debug',
            `Health check: Node ${name} is unresponsive (failure ${failures}/${this.MAX_HEALTH_CHECK_FAILURES}): ${error instanceof Error ? error.message : 'Unknown error'}`
          );
          if (failures >= this.MAX_HEALTH_CHECK_FAILURES) {
            nodesToRemove.push(name);
          }
        }
      }
    }

    // Remove dead nodes after multiple failures
    for (const name of nodesToRemove) {
      this.healthCheckFailures.delete(name);
      this.eventEmitter?.emit('debug', `Removing dead node after multiple health check failures: ${name}`);
      this.removeNode(name);
    }
  }

  /**
   * Add a node to the manager
   */
  public async addNode(options: NodeOptions): Promise<Node> {
    if (this.nodes.has(options.name)) {
      throw new Error(`Node with name ${options.name} already exists`);
    }

    if (!this.clientId) {
      throw new Error('NodeManager not initialized. Call init() first.');
    }

    const node = new Node(options);
    this.setupNodeEventHandlers(node);
    this.nodes.set(options.name, node);

    try {
      await node.connect(this.clientId);
      return node;
    } catch (error) {
      this.nodes.delete(options.name);
      throw error;
    }
  }

  /**
   * Remove a node from the manager
   */
  public removeNode(name: string): boolean {
    const node = this.nodes.get(name);
    if (!node) {
      return false;
    }

    node.disconnect();
    this.nodes.delete(name);
    return true;
  }

  /**
   * Get a node by name
   */
  public getNode(name: string): Node | undefined {
    return this.nodes.get(name);
  }

  /**
   * Get all nodes
   */
  public getNodes(): Node[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get all connected nodes
   */
  public getConnectedNodes(): Node[] {
    return this.getNodes().filter((node) => node.isConnected());
  }

  /**
   * Get the best node based on penalty calculation
   * This is the core load balancing logic
   */
  public getBestNode(voiceRegion?: string): Node {
    const connectedNodes = this.getConnectedNodes();
    const totalNodes = this.nodes.size;

    if (connectedNodes.length === 0) {
      const nodeNames = Array.from(this.nodes.keys()).join(', ');
      this.eventEmitter?.emit(
        'debug',
        `No connected nodes available! Total: ${totalNodes}, Connected: 0. Nodes: [${nodeNames}]`
      );
      throw new Error(`No connected nodes available (${totalNodes} total nodes configured)`);
    }

    // If voice region optimization is requested, prefer nodes in the same region
    if (voiceRegion) {
      const regionalNodes = connectedNodes.filter(node => 
        node.options.region && this.matchesRegion(node.options.region, voiceRegion)
      );
      
      if (regionalNodes.length > 0) {
        this.eventEmitter?.emit(
          'debug',
          `Selected best node from ${regionalNodes.length} regional nodes (region: ${voiceRegion})`
        );
        return this.selectBestFromNodes(regionalNodes);
      } else {
        this.eventEmitter?.emit(
          'debug',
          `No regional nodes found for region ${voiceRegion}, using best overall node from ${connectedNodes.length} connected nodes`
        );
      }
    } else {
      this.eventEmitter?.emit(
        'debug',
        `Selected best node from ${connectedNodes.length} connected nodes (${totalNodes} total)`
      );
    }

    return this.selectBestFromNodes(connectedNodes);
  }

  /**
   * Select best node from a list based on penalty
   */
  private selectBestFromNodes(nodes: Node[]): Node {
    const penaltyFn = this.customPenaltyCalculator || ((node: Node) => node.getPenalty());

    let bestNode = nodes[0];
    let lowestPenalty = penaltyFn(bestNode);

    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i];
      const penalty = penaltyFn(node);

      if (penalty < lowestPenalty) {
        lowestPenalty = penalty;
        bestNode = node;
      }
    }

    return bestNode;
  }

  /**
   * Check if node region matches voice region
   */
  private matchesRegion(nodeRegion: string, voiceRegion: string): boolean {
    // Normalize regions (e.g., us-west, uswest, us_west all match)
    const normalize = (r: string) => r.toLowerCase().replace(/[-_]/g, '');
    return normalize(nodeRegion).includes(normalize(voiceRegion)) || 
           normalize(voiceRegion).includes(normalize(nodeRegion));
  }

  /**
   * Get node penalties for all connected nodes
   */
  public getNodePenalties(): Map<string, number> {
    const penalties = new Map<string, number>();
    const penaltyFn = this.customPenaltyCalculator || ((node: Node) => node.getPenalty());

    for (const [name, node] of this.nodes) {
      if (node.isConnected()) {
        penalties.set(name, penaltyFn(node));
      } else {
        penalties.set(name, Infinity);
      }
    }

    return penalties;
  }

  /**
   * Get detailed penalty breakdown for all nodes
   */
  public getNodePenaltyDetails(): Map<
    string,
    ReturnType<Node['getPenaltyDetails']>
  > {
    const details = new Map<string, ReturnType<Node['getPenaltyDetails']>>();

    for (const [name, node] of this.nodes) {
      details.set(name, node.getPenaltyDetails());
    }

    return details;
  }

  /**
   * Set a custom penalty calculator
   * Allows users to implement their own load balancing logic
   */
  public setPenaltyCalculator(calculator: PenaltyCalculator): void {
    this.customPenaltyCalculator = calculator;
  }

  /**
   * Reset to default penalty calculator
   */
  public resetPenaltyCalculator(): void {
    this.customPenaltyCalculator = null;
  }

  /**
   * Disconnect all nodes
   */
  public disconnectAll(): void {
    this.stopHealthCheck();
    this.healthCheckFailures.clear();
    for (const node of this.nodes.values()) {
      node.disconnect();
    }
    this.nodes.clear();
  }

  /**
   * Get aggregate stats from all nodes
   */
  public getAggregateStats(): {
    totalNodes: number;
    connectedNodes: number;
    totalPlayers: number;
    totalPlayingPlayers: number;
    averageCpuLoad: number;
    totalMemoryUsed: number;
    totalMemoryAllocated: number;
  } {
    const connectedNodes = this.getConnectedNodes();
    let totalPlayers = 0;
    let totalPlayingPlayers = 0;
    let totalCpuLoad = 0;
    let totalMemoryUsed = 0;
    let totalMemoryAllocated = 0;

    for (const node of connectedNodes) {
      if (node.stats) {
        totalPlayers += node.stats.players;
        totalPlayingPlayers += node.stats.playingPlayers;
        totalCpuLoad += node.stats.cpu.lavalinkLoad;
        totalMemoryUsed += node.stats.memory.used;
        totalMemoryAllocated += node.stats.memory.allocated;
      }
    }

    return {
      totalNodes: this.nodes.size,
      connectedNodes: connectedNodes.length,
      totalPlayers,
      totalPlayingPlayers,
      averageCpuLoad: connectedNodes.length > 0 ? totalCpuLoad / connectedNodes.length : 0,
      totalMemoryUsed,
      totalMemoryAllocated,
    };
  }

  /**
   * Health check for all nodes
   */
  public async healthCheck(): Promise<Map<string, boolean>> {
    const health = new Map<string, boolean>();

    for (const [name, node] of this.nodes) {
      try {
        if (node.isConnected()) {
          // Try to fetch stats as a health check
          await node.getStats();
          health.set(name, true);
        } else {
          health.set(name, false);
        }
      } catch (error) {
        health.set(name, false);
      }
    }

    return health;
  }

  // ==================== Private Methods ====================

  /**
   * Get human-readable description of disconnect code
   */
  private getDisconnectReason(code: number, reason: string): string {
    const codeDescriptions: Record<number, string> = {
      1000: 'Normal closure',
      1001: 'Going away',
      1002: 'Protocol error',
      1003: 'Unsupported data',
      1006: 'Abnormal closure (connection lost)',
      1007: 'Invalid frame payload',
      1008: 'Policy violation',
      4000: 'Heartbeat timeout (node unresponsive)',
      4001: 'Lavalink declined the connection',
      4002: 'Lavalink server encountered an error',
    };
    const description = codeDescriptions[code] || 'Unknown reason';
    return `${description} (code: ${code}, details: ${reason || 'none'})`;
  }

  /**
   * Setup event handlers for a node
   */
  private setupNodeEventHandlers(node: Node): void {
    if (!this.eventEmitter) {
      return;
    }

    node.on('onConnect', () => {
      this.eventEmitter!.emit('nodeConnect', node);
      this.eventEmitter!.emit(
        'debug',
        `✓ Node ${node.options.name} connected successfully (${node.options.host}:${node.options.port})`
      );
    });

    node.on('onDisconnect', (code, reason) => {
      this.eventEmitter!.emit('nodeDisconnect', node, code, reason);
      const disconnectReason = this.getDisconnectReason(code, reason);
      this.eventEmitter!.emit(
        'debug',
        `✗ Node ${node.options.name} disconnected: ${disconnectReason}`
      );
      // Log connected nodes count
      const connected = this.getConnectedNodes();
      if (connected.length === 0) {
        this.eventEmitter!.emit(
          'debug',
          `⚠ WARNING: No connected nodes available! You have ${this.nodes.size} total nodes configured.`
        );
      } else {
        this.eventEmitter!.emit(
          'debug',
          `⚠ Remaining connected nodes: ${connected.length}/${this.nodes.size}`
        );
      }
    });

    node.on('onError', (error) => {
      this.eventEmitter!.emit('nodeError', node, error);
      this.eventEmitter!.emit(
        'debug',
        `✗ Node ${node.options.name} error: ${error.message}`
      );
    });

    node.on('onReconnecting', (attempt) => {
      this.eventEmitter!.emit('nodeReconnect', node, attempt);
      this.eventEmitter!.emit(
        'debug',
        `🔄 Node ${node.options.name} attempting reconnection (attempt ${attempt}/${node.options.maxReconnectAttempts})`
      );
    });

    node.on('onStats', (stats) => {
      this.eventEmitter!.emit('nodeStats', node, stats);
    });

    node.on('onReady', (sessionId, resumed) => {
      const resumeStatus = resumed ? 'resumed' : 'new session';
      this.eventEmitter!.emit(
        'debug',
        `✓ Node ${node.options.name} ready (${resumeStatus}, session: ${sessionId})`
      );
    });
  }

  /**
   * Get metrics for all nodes
   */
  public getNodeMetrics(): Array<ReturnType<Node['getMetrics']>> {
    return Array.from(this.nodes.values()).map(node => node.getMetrics());
  }

  /**
   * Get metrics for a specific node
   */
  public getNodeMetricsById(name: string): ReturnType<Node['getMetrics']> | undefined {
    const node = this.nodes.get(name);
    return node?.getMetrics();
  }
}

/**
 * Helper function to get the singleton instance
 */
export function getNodeManager(): NodeManager {
  return NodeManager.getInstance();
}
