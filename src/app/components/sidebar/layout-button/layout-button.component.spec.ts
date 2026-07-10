import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LayoutButtonComponent } from './layout-button.component';

describe('LayoutButtonComponent', () => {
    let component: LayoutButtonComponent;
    let fixture: ComponentFixture<LayoutButtonComponent>;

    beforeEach(async () => {
        await TestBed.configureTestingModule({
            imports: [LayoutButtonComponent],
        }).compileComponents();

        fixture = TestBed.createComponent(LayoutButtonComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });
});
