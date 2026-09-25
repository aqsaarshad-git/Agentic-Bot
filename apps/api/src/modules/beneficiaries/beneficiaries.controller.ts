import { Controller, ForbiddenException, Get } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPrincipal } from '../../common/types/auth-principal';
import { BeneficiariesService } from './beneficiaries.service';

@Controller('beneficiaries')
export class BeneficiariesController {
  constructor(private readonly beneficiaries: BeneficiariesService) {}

  @Get()
  findAll(@CurrentUser() actor: AuthPrincipal) {
    if (actor.type !== 'customer') {
      throw new ForbiddenException('Specify a customer to view beneficiaries for');
    }
    return this.beneficiaries.findForCustomer(actor.sub);
  }
}
