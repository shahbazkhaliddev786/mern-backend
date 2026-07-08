export { connectDB } from './db.service.js';

export {
    registerUser,
    sendOTP,
    verifyOTP,
    loginWithPassword,
    refreshAccessToken,
    getUserById,
    logout,
    updateUserProfile,
    forgotPassword,
    resetPasswordWithOtp,
    deleteUserAccount
} from './auth.service.js';

export {
    getCart,
    addToCart,
    removeFromCart,
    updateCartItem,
    clearCart,
    mergeGuestCartOnLogin,
    calculateCartTotals,
    CART_ITEM_POPULATE
} from "./cart.service.js"

export {
    getAllCartsService,
    getCartByUserIdService,
    adminUpdateCartItemService,
    adminRemoveCartItemService,
    adminClearCartService
} from "./admin-cart.service.js"

export {
    createCheckoutSession,
    updateOrderStatus,
    deleteOrder,
    getUserOrders,
    getOrderById,
    getMyOrders
} from './order.service.js';

export {
    getAllOrdersService,
    adminUpdateOrderDetailsService
} from './admin-order.service.js';

export {
    getAllUsersService,
    adminUpdateUserRoleService,
    adminDeleteUserService
} from './admin-user.service.js';

export {
    getDashboardSummaryService
} from './admin-dashboard.service.js';