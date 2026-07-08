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
  getProfile,
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
  getAllCarts,
  getCartByUserId,
  adminUpdateCartItem,
  adminRemoveCartItem,
  adminClearCart
} from "./admin-cart.controller.js"

export {
  createOrder,
  updateOrder,
  deleteOrderCtrl,
  getOrders,
  getOrder,
  getMyOrdersController
} from './order.controller.js';

export {
  getAllOrders,
  getAdminOrder,
  adminUpdateOrderStatus,
  adminUpdateOrderDetails,
  adminDeleteOrder
} from './admin-order.controller.js';

export {
  getAllUsers,
  getAdminUser,
  adminUpdateUserRole,
  adminDeleteUser
} from './admin-user.controller.js';

export {
  getDashboardSummary
} from './admin-dashboard.controller.js';
