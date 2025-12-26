
export interface AddToCartBody {
  productId: string;
  quantity?: number;
}

export interface UpdateCartItemBody {
  quantity: number;
}

export type CartItemParams = Record<string, string>;