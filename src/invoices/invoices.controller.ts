import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RiderInvoiceListQueryDto } from './dto/invoice-admin.dto';
import { InvoicesService } from './invoices.service';

@ApiTags('Invoices')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid BhaiWay JWT' })
@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List tax invoices for the authenticated rider',
    description:
      'Returns issued GST invoices for the JWT subject only. Optional rideId / bookingId filter the trip. Pending Regular and Daily Office Commute jobs for this rider are processed before the list is returned so Get Invoice can resolve after ride completion.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: RiderInvoiceListQueryDto,
  ) {
    return this.invoicesService.listForRider(
      user.userId,
      query.page,
      query.limit,
      query.rideId,
      query.bookingId,
    );
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Download the rider tax invoice PDF' })
  @ApiOkResponse({ description: 'PDF binary' })
  async downloadPdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const file = await this.invoicesService.downloadPdfForRider(user.userId, id);
    return new StreamableFile(file.buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a tax invoice owned by the authenticated rider' })
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invoicesService.getForRider(user.userId, id);
  }
}
