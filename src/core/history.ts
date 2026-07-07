/**
 * Conversation history + past-conversation listing.
 *
 * - io-logs: the ordered turns of one conversation (workflowId + interactionId).
 * - interactions: the list of past conversations for a sidebar.
 */
import { HttpClient } from './client';
import type { Conversation, HistoryTurn } from './types';

interface RawIoLog {
  log_id: number;
  io_id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  input_data: string;
  output_data: string;
  updated_at: string;
}

interface RawInteraction {
  id: number;
  interaction_id: string;
  workflow_id: string;
  workflow_name: string;
  interaction_count?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export class HistoryApi {
  constructor(private http: HttpClient) {}

  /** Ordered turns of one conversation. */
  async turns(workflowId: string, interactionId: string, workflowName?: string): Promise<HistoryTurn[]> {
    const params = new URLSearchParams({ workflow_id: workflowId, interaction_id: interactionId });
    if (workflowName) params.set('workflow_name', workflowName);
    const res = await this.http.get<{ in_out_logs?: RawIoLog[] }>(`/api/chat/io-logs?${params}`);
    return (res.in_out_logs ?? []).map((r) => ({
      logId: r.log_id,
      ioId: r.io_id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      input: r.input_data,
      output: r.output_data,
      updatedAt: r.updated_at,
    }));
  }

  /** Past conversations (interactions) for the sidebar. */
  async conversations(): Promise<Conversation[]> {
    const res = await this.http.get<{ execution_meta_list?: RawInteraction[] }>('/api/interaction/list');
    return (res.execution_meta_list ?? []).map((r) => ({
      id: r.id,
      interactionId: r.interaction_id,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      interactionCount: r.interaction_count ?? 0,
      metadata: r.metadata ?? {},
      createdAt: r.created_at ?? '',
      updatedAt: r.updated_at ?? '',
    }));
  }
}
