import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClusterPlanPanel } from './ClusterPlanPanel';

describe('ClusterPlanPanel', () => {
  it('renders 3-tier memory breakdown and MoE/RPC flags', () => {
    render(
      <ClusterPlanPanel
        plan={{
          strategy: 'multi_node_rpc',
          feasible: true,
          is_moe: true,
          total_demand_bytes: 80 * 1024 ** 3,
          tier1_gpu_bytes: 12 * 1024 ** 3,
          tier2_ram_bytes: 68 * 1024 ** 3,
          tier3_disk_mmap_bytes: 0,
          node_allocations: [
            { name: 'Apple M3', role: 'coordinator', endpoint: '127.0.0.1', allocated_bytes: 12 * 1024 ** 3, budget_bytes: 12 * 1024 ** 3 },
            { name: 'RTX-Node', role: 'rpc_worker', endpoint: '192.168.1.50:50052', allocated_bytes: 68 * 1024 ** 3, budget_bytes: 68 * 1024 ** 3 },
          ],
          runtime_flags: ['--split-mode', 'layer', '--rpc', '192.168.1.50:50052', '-ot', 'exps=CPU'],
          warnings: ['Cross-node GGML_RPC pools memory over TCP; token speed is bounded by network RTT.'],
        }}
      />
    );

    expect(screen.getByText('multi_node_rpc')).toBeInTheDocument();
    expect(screen.getByText('Pooled RPC Nodes')).toBeInTheDocument();
    expect(screen.getByText(/exps=CPU/)).toBeInTheDocument();
  });
});
