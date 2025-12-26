
// TODO: Analyze and improve validation, if needed


export {
    createBrandValidation,
    updateBrandValidation,
    brandIdValidation
} from './brand.validations.js';

export {
    createCategoryValidation,
    updateCategoryValidation,
    categoryIdValidation
} from './category.validations.js';

export {
    addToCartValidation,
    updateCartItemValidation,
    removeFromCartValidation
} from './cart.validation.js';

export {
    registerValidation,
    loginValidation,
    resendOtpValidation,
    verifyOtpValidation,
    refreshTokenValidation
} from './auth.validations.js';

export {
    createOrderValidation,
    updateOrderStatusValidation
} from './order.validations.js';