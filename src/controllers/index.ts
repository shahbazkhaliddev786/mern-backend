export { self, health } from './health.controller.js';

export {
  createCategory,
  getCategories,
  getCategory,
  updateCategory,
  deleteCategory,
} from './category.controller.js';

export {
  createBrand,
  getBrands,
  getBrand,
  updateBrand,
  deleteBrand,
} from './brand.controller.js';

export {
  createProduct,
  getProducts,
  getProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/product.controller.js';

export {  
  register,
  resendOTP,
  verifyOtp,
  login,
  refreshToken,
  logoutUser,
  updateProfile,
  forgetPassword,
  resetPassword,
  deleteAccount
} from './auth.controller.js';

export {
  getUserCart,
  addItemToCart,
  updateItemInCart,
  removeItemFromCart,
  clearUserCart
} from "./cart.controller.js"

export {
  createOrder,
  updateOrder,
  deleteOrderCtrl,
  getOrders,
  getOrder,
} from './order.controller.js';
