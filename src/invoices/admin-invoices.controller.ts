import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { memoryStorage } from 'multer';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RequireAdminPermission } from '../admin/decorators/require-admin-permission.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import {
  AdminInvoiceListQueryDto,
  CreateInvoiceTaxConfigDto,
  UpdateInvoiceTaxConfigDto,
  UpsertInvoiceIssuerDto,
} from './dto/invoice-admin.dto';
import {
  ADMIN_PERMISSION_INVOICES_MANAGE,
  ADMIN_PERMISSION_INVOICES_VIEW,
  INVOICE_LOGO_MAX_BYTES,
} from './invoice.constants';
import { InvoicesService } from './invoices.service';

@ApiTags('Admin Invoices')
@ApiBearerAuth('bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid admin JWT' })
@ApiForbiddenResponse({ description: 'Admin invoice permission required' })
@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, AdminPermissionGuard)
export class AdminInvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get('config')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_VIEW)
  @ApiOperation({ summary: 'View issuer settings and tax configurations' })
  getConfig() {
    return this.invoicesService.getAdminConfig();
  }

  @Put('issuer')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_MANAGE)
  @ApiOperation({ summary: 'Create or update the GST issuing entity' })
  upsertIssuer(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: UpsertInvoiceIssuerDto,
  ) {
    return this.invoicesService.upsertIssuer(admin.userId, body);
  }

  @Post('tax-configs')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_MANAGE)
  @ApiOperation({ summary: 'Create an invoice tax configuration' })
  createTaxConfig(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() body: CreateInvoiceTaxConfigDto,
  ) {
    return this.invoicesService.createTaxConfig(admin.userId, body);
  }

  @Patch('tax-configs/:id')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_MANAGE)
  @ApiOperation({ summary: 'Update an invoice tax configuration' })
  updateTaxConfig(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateInvoiceTaxConfigDto,
  ) {
    return this.invoicesService.updateTaxConfig(admin.userId, id, body);
  }

  @Post('logo')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_MANAGE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: INVOICE_LOGO_MAX_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Upload or replace the invoice logo' })
  uploadLogo(
    @CurrentUser() admin: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.invoicesService.uploadLogo(admin.userId, file);
  }

  @Get()
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_VIEW)
  @ApiOperation({ summary: 'List issued GST invoices and delivery status' })
  list(@Query() query: AdminInvoiceListQueryDto) {
    return this.invoicesService.listAdmin(query);
  }

  @Get(':id/pdf')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_VIEW)
  @ApiOperation({ summary: 'Download an issued invoice PDF (admin)' })
  @ApiOkResponse({ description: 'PDF binary' })
  async downloadPdf(@Param('id', ParseUUIDPipe) id: string) {
    const file = await this.invoicesService.downloadPdfAdmin(id);
    return new StreamableFile(file.buffer, {
      type: 'application/pdf',
      disposition: `attachment; filename="${file.filename}"`,
    });
  }

  @Get(':id')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_VIEW)
  @ApiOperation({ summary: 'Invoice detail and email delivery status' })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoicesService.getAdmin(id);
  }

  @Post(':id/retry-email')
  @RequireAdminPermission(ADMIN_PERMISSION_INVOICES_MANAGE)
  @ApiOperation({ summary: 'Retry failed invoice email delivery' })
  retryEmail(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoicesService.retryEmail(id);
  }
}
