import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_SNACK_BAR_DATA, MatSnackBarRef } from '@angular/material/snack-bar';

import { ToasterComponent } from './toaster.component';

describe('ToasterComponent', () => {
    let component: ToasterComponent;
    let fixture: ComponentFixture<ToasterComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [ToasterComponent],
            providers: [
                {
                    provide: MatSnackBarRef,
                    useValue: {
                        dismiss: () => {
                            /* empty testing only */
                        },
                    },
                },
                {
                    provide: MAT_SNACK_BAR_DATA,
                    useValue: { type: 'success', heading: '', message: '' },
                },
            ],
        }).compileComponents();

        fixture = TestBed.createComponent(ToasterComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });
});
