import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { IdentifyCustomerDto } from './dto/identify-customer.dto';
import { VerifyCustomerOtpDto } from './dto/verify-customer-otp.dto';

// Sensitive/brute-forceable endpoints get a much tighter limit than the app-wide default.
const AUTH_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('register')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  registerUser(@Body() dto: RegisterUserDto) {
    return this.authService.registerUser(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('customer-identify')
  identifyCustomer(@Body() dto: IdentifyCustomerDto) {
    return this.authService.identifyCustomer(dto);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('customer-verify-otp')
  verifyCustomerOtp(@Body() dto: VerifyCustomerOtpDto) {
    return this.authService.verifyCustomerOtp(dto);
  }
}
