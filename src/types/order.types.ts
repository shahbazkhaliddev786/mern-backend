
export interface UpdateOrderBody {
  status: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled';
}

export type OrderParams = Record<string, string>;