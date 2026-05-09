import { APP_BASE_HREF, PlatformLocation } from '@angular/common';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { bootstrapApplication, BrowserModule } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule } from '@angular/forms';
import { AppComponent } from './app/app.component';
import { importProvidersFrom } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { IlpnAlgorithmsModule } from '../ilpn-components/src/lib/algorithms/ilpn-algorithms.module';

bootstrapApplication(AppComponent, {
    providers: [
        importProvidersFrom(
            BrowserModule,
            MatFormFieldModule,
            MatInputModule,
            MatButtonModule,
            MatIconModule,
            ReactiveFormsModule,
            IlpnAlgorithmsModule,
            TranslateModule.forRoot({
                fallbackLang: 'en',
            }),
        ),
        provideTranslateHttpLoader({
            prefix: './assets/i18n/',
            suffix: '.json',
        }),
        {
            provide: APP_BASE_HREF,
            useFactory: (s: PlatformLocation) => s.getBaseHrefFromDOM(),
            deps: [PlatformLocation],
        },
        provideHttpClient(withInterceptorsFromDi()),
        provideAnimations(),
    ],
}).catch((err) => console.error(err));
