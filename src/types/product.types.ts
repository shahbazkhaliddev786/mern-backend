
export interface CreateProductBody {
  name: string;
  description: string;
  price: number;
  stock?: number;
  category: string;
  brand: string;
}

export interface UpdateProductBody {
  name?: string;
  description?: string;
  price?: number;
  stock?: number;
  category?: string;
  brand?: string;
}


export type ProductParams = Record<string, string>;
