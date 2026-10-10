# Your account

## How do I create an account?

Choose Sign up and enter your name, email address and a password; a profile picture is optional. We email you a 6-digit code, and entering it on the verification page activates your account. The code expires after 5 minutes, and you can ask for a new one there.

<!-- source: mern-frontend signup and verify-email pages; src/services/auth.service.ts (5-minute codes) -->

## What are the password rules?

Passwords need at least 6 characters, including an uppercase letter, a lowercase letter, a number and one of these symbols: ! @ # $ % ^ & *

<!-- source: src/validations/auth.validations.ts (strongPassword) -->

## I didn't get my verification code. What can I do?

On the verification page you see after signing up, choose Resend to get a new code. Each code expires after 5 minutes and stops working after 5 wrong tries.

<!-- source: mern-frontend verify-email page; src/services/auth.service.ts (consumeOtp) -->

## I forgot my password. How do I reset it?

On the sign-in page, choose "Forgot password?" and enter your email address. If an account uses that address, we email it a 6-digit code. Enter the code with your new password. The code expires after 5 minutes. Resetting your password signs you out on all your devices.

<!-- source: mern-frontend forgot-password page; src/services/auth.service.ts (resetPasswordWithOtp) -->

## How do I change my password?

Open your profile, choose Edit Profile and use the Change Password section. You need your current password. You stay signed in on the device you're using, and your other devices are signed out.

<!-- source: mern-frontend change-password-card.tsx; src/services/auth.service.ts (changeUserPassword) -->

## How do I change my email address?

Open your profile, choose Edit Profile and use the Change Email section. Enter the new address and your current password, and we email a 6-digit code to the new address. Your email changes only once you enter that code, within 5 minutes.

<!-- source: mern-frontend change-email-card.tsx; src/services/auth.service.ts (requestUserEmailChange, confirmUserEmailChange) -->

## How do I change my name or profile picture?

Open your profile and choose Edit Profile. Profile pictures can be JPEG, PNG, GIF or WEBP images of up to 2 MB.

<!-- source: mern-frontend edit-profile-page.tsx; src/middlewares/multer.middleware.ts (avatar limits) -->
