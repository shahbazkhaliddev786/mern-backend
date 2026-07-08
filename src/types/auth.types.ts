
export interface RegisterBody {
  name: string;
  email: string;
  password: string;
}

export interface UserType {
  _id: string;
  name?: string;
  email?: string;
}

export interface ResendOtpBody {
  email: string;
}

export interface VerifyOtpBody {
  email: string;
  otp: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface RefreshTokenBody {
  refreshToken: string;
}

export interface LogoutBody {
  refreshToken?: string;
}

export interface UpdateProfileBody {
  name?: string;
}

export interface ForgotPasswordBody {
  email: string;
}

export interface ResetPasswordWithOtpBody {
  email: string;
  otp: string;
  newPassword: string;
  confirmPassword: string;
}

export interface DeleteAccountBody {
  password: string; 
}