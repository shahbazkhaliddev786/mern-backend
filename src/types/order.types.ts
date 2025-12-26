
export interface UpdateOrderBody {
  status: 'pending' | 'dispatched' | 'completed';
}

export type OrderParams = Record<string, string>;