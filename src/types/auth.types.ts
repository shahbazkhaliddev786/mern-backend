export interface RegisterBody {
  name: string;
  email: string;
  password: string;
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